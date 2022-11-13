import {Injectable} from '@nestjs/common';
import {InjectModel} from '@nestjs/mongoose';
import {Model, Types} from 'mongoose';

import {MailDto, ParticipantDto, PollDto, PollEventDto} from '../../dto';
import {Participant, Poll, PollEvent} from '../../schema';
import {MailService} from '../../mail/mail/mail.service';
import {ReadPollDto, ReadStatsPollDto} from '../../dto/read-poll.dto';

@Injectable()
export class PollService {
    constructor(
        @InjectModel(Poll.name) private pollModel: Model<Poll>,
        @InjectModel(PollEvent.name) private pollEventModel: Model<PollEvent>,
        @InjectModel(Participant.name) private participantModel: Model<Participant>,
        private mailService: MailService,
    ) {
    }

    async getPolls(token: string): Promise<ReadStatsPollDto[]> {
        const adminPolls = await this.pollModel.find({adminToken: token}).select('-adminToken').exec();
        const participants = await this.participantModel.find({token}, null, {populate: 'poll'}).exec();
        const participantPolls = participants.map(participant => participant.poll);
        let polls = [...adminPolls, ...participantPolls];
        const filteredPolls = polls.filter((poll: Poll, index) => polls.findIndex((p: any) => p._id.toString() === poll._id.toString()) === index);
        const readPolls = filteredPolls.map(async (poll: Poll): Promise<ReadStatsPollDto> => ({
            _id: poll._id,
            title: poll.title,
            description: poll.description,
            location: poll.location,
            settings: poll.settings,
            bookedEvents: poll.bookedEvents,
            events: await this.pollEventModel.count({poll: poll._id}).exec(),
            participants: await this.participantModel.count({poll: poll._id}).exec(),
        }));

        return Promise.all(readPolls);
    };

    async getPoll(id: string): Promise<ReadPollDto> {
        return this.pollModel.findById(id).select('-adminToken').exec();
    }

    async postPoll(pollDto: PollDto): Promise<ReadPollDto> {
        const poll = await this.pollModel.create(pollDto);
        return this.pollModel.findById(poll._id).select('-adminToken').exec();
    }

    async putPoll(id: string, pollDto: PollDto): Promise<ReadPollDto> {
        return this.pollModel.findByIdAndUpdate(id, pollDto, {new: true}).select('-adminToken').exec();
    }

    async clonePoll(id: string): Promise<ReadPollDto> {
        const poll = await this.pollModel.findById(id).exec();
        const pollEvents = await this.pollEventModel.find({poll: new Types.ObjectId(id)}).exec();
        const clonedPoll = await this.pollModel.create({
            title: `${poll.title} (clone)`,
            description: poll.description,
            location: poll.location,
            adminToken: poll.adminToken,
            settings: poll.settings,
        });
        const clonedPollEvents = pollEvents.map(event => ({
            poll: clonedPoll._id,
            start: event.start,
            end: event.end,
            note: event.note,
        }));
        await this.pollEventModel.create(clonedPollEvents);
        return this.pollModel.findById(clonedPoll._id).select('-adminToken').exec();
    }

    async deletePoll(id: string): Promise<ReadPollDto | undefined> {
        const poll = await this.pollModel.findByIdAndDelete(id).exec();
        if (!poll) {
            return;
        }

        await this.pollEventModel.deleteMany({poll: new Types.ObjectId(id)}).exec();
        await this.participantModel.deleteMany({poll: new Types.ObjectId(id)}).exec();
        poll.adminToken = undefined;
        return poll;
    }

    async getEvents(id: string): Promise<PollEvent[]> {
        return await this.pollEventModel.find({poll: new Types.ObjectId(id)}).exec();
    }

    async postEvents(id: string, pollEvents: PollEventDto[]): Promise<PollEvent[]> {
        const oldEvents = await this.pollEventModel.find({poll: new Types.ObjectId(id)}).exec();
        const newEvents = pollEvents.filter(event => !oldEvents.some(oldEvent => oldEvent._id.toString() === event._id));
        await this.pollEventModel.create(newEvents.map(event => ({...event, poll: new Types.ObjectId(id)})));

        const updatedEvents = pollEvents.filter(event => {
            const oldEvent = oldEvents.find(e => e._id.toString() === event._id);
            if (!oldEvent) {
                return false;
            }
            return oldEvent.start !== event.start || oldEvent.end !== event.end;
        });
        if (updatedEvents.length > 0) {
            for (const event of updatedEvents) {
                await this.pollEventModel.findByIdAndUpdate(event._id, event).exec();
            }
        }

        const deletedEvents = oldEvents.filter(event => !pollEvents.some(e => e._id === event._id.toString()));
        await this.pollEventModel.deleteMany({_id: {$in: deletedEvents.map(event => event._id)}}).exec();
        await this.removeParticipations(id, updatedEvents);
        return await this.pollEventModel.find({poll: new Types.ObjectId(id)}).exec();
    }

    async getParticipants(id: string) {
        return this.participantModel.find({poll: id}).populate(['participation', 'indeterminateParticipation']).exec();
    }

    async postParticipation(id: string, participant: ParticipantDto): Promise<Participant> {
        return this.participantModel.create({
            poll: id,
            name: participant.name,
            participation: participant.participation,
            indeterminateParticipation: participant.indeterminateParticipation,
            token: participant.token,
            mail: participant.mail,
        });
    }

    async editParticipation(id: string, participantId: string, participant: ParticipantDto): Promise<Participant> {
        return this.participantModel.findByIdAndUpdate(participantId, participant, {new: true}).exec();
    }

    async deleteParticipation(id: string, participantId: string): Promise<Participant> {
        return this.participantModel.findByIdAndDelete(participantId).exec();
    }

    async bookEvents(id: string, events: string[]): Promise<ReadPollDto> {
        const poll = await this.pollModel.findById(id).exec();
        poll.bookedEvents = await this.pollEventModel.find({_id: {$in: events}}).exec();
        this.mailParticipants(id, poll).then();
        return this.pollModel.findByIdAndUpdate(id, poll, {new: true}).select('-adminToken').exec();
    }

    private async mailParticipants(id: string, poll: Poll) {
        const participants = await this.participantModel.find({poll: id}).populate(['participation', 'indeterminateParticipation']).exec();
        participants.forEach(participant => {
            const participations = [...participant.participation, ...participant.indeterminateParticipation];
            const appointments = [];
            poll.bookedEvents.forEach((event: any) => {
                if (participations.some((participation: any) => participation._id.toString() === event._id.toString())) {
                    appointments.push(`${new Date(event.start).toLocaleString()} - ${new Date(event.end).toLocaleString()} *`);
                } else {
                    appointments.push(`${new Date(event.start).toLocaleString()} - ${new Date(event.end).toLocaleString()}`);
                }
                // TODO: use includes and remove any-type (not working currently)
            });
            this.mailService.sendMail(participant.mail, appointments);
        });
    }

    private async removeParticipations(id: string, events: PollEventDto[]) {
        const changedParticipants = await this.participantModel.find({
            poll: id,
            participation: {$in: events.map(event => event._id)},
        }).exec();
        const indeterminateParticipants = await this.participantModel.find({
            poll: id,
            indeterminateParticipation: {$in: events.map(event => event._id)},
        });

        for (const participant of changedParticipants) {
            participant.participation = participant.participation.filter((event: any) =>
                !events.some(e => e._id.toString() === event._id.toString()));
            await this.participantModel.findByIdAndUpdate(participant._id, participant).exec();
        }

        for (const participant of indeterminateParticipants) {
            participant.indeterminateParticipation = participant.indeterminateParticipation.filter((event: any) =>
                !events.some(e => e._id.toString() === event._id.toString()));
            await this.participantModel.findByIdAndUpdate(participant._id, participant).exec();
        }
    }

    async setMail(mailDto: MailDto) {
        const participants = await this.participantModel.find({token: mailDto.token}).exec();
        participants.forEach(participant => {
            participant.mail = mailDto.mail;
            participant.token = mailDto.token;
        });
        await this.participantModel.updateMany({token: mailDto.token}, {
            mail: mailDto.mail,
            token: mailDto.token,
        }).exec();
    }

    async isAdmin(id: string, token: string) {
        return this.pollModel.findById(id).exec().then(poll => poll.adminToken === token);
    }
}
