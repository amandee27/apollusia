import {Component} from '@angular/core';
import {saveAs} from "file-saver";
import {ICalAttendeeStatus, ICalCalendar, ICalCalendarMethod} from "ical-generator";

import {ICalConfig} from "./ical-config";
import {Participant, ReadPoll, ReadPollEvent} from "../../model/index.js";

@Component({
  selector: 'apollusia-ical',
  templateUrl: './ical.component.html',
  styleUrl: './ical.component.scss',
})
export class IcalComponent {
  poll?: ReadPoll;
  pollEvents?: ReadPollEvent[];
  participants?: Participant[];
  url: string;

  config = new ICalConfig();

  export() {
    const {url, participants, poll, pollEvents, config} = this;
    if (!poll || !pollEvents || !participants) {
      return;
    }

    const calendar = new ICalCalendar({
      name: poll.title,
      description: poll.description,
      url,
      timezone: poll.timeZone,
      method: ICalCalendarMethod.REQUEST,
    });

    for (const event of pollEvents) {
      const eventParticipants = participants.filter(p => p.selection[event._id] === 'yes' || p.selection[event._id] === 'maybe');
      if (!eventParticipants) {
        continue;
      }

      let summary = config.customTitle ?? poll.title;
      if (eventParticipants.length === 1) {
        summary += `: ${eventParticipants[0].name}`;
      }

      let description = poll.description;
      if (event.note) {
        description += `\n\nNote: ${event.note}`;
      }
      description += `\n\nParticipants:\n${eventParticipants.map(p => `- ${p.name} (${p.selection[event._id]})`).join('\n')}`;

      const iCalEvent = calendar.createEvent({
        id: event._id,
        timezone: poll.timeZone,
        start: new Date(event.start),
        end: new Date(event.end),
        summary,
        description,
        location: poll.location,
        url,
      });
      if (config.inviteParticipants) {
        for (const participant of eventParticipants) {
          participant.mail && iCalEvent.createAttendee({
            name: participant.name,
            email: participant.mail,
            status: participant.selection[event._id] === 'yes' ? ICalAttendeeStatus.ACCEPTED : ICalAttendeeStatus.TENTATIVE,
          });
        }
      }
    }

    saveAs(new Blob([calendar.toString()], {type: 'text/calendar'}), `${poll.title}.ics`);
  }
}
