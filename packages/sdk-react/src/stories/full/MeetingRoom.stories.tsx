import type { Meta, StoryObj } from '@storybook/react';
import { MeetingRoom } from '../../components/full/MeetingRoom';

const meta: Meta<typeof MeetingRoom> = {
  title: 'Full/MeetingRoom',
  component: MeetingRoom,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof MeetingRoom>;

const participants = [
  { id: '1', displayName: 'Dr. Smith', role: 'host', isVideoEnabled: true, isAudioEnabled: true, isSpeaking: true },
  { id: '2', displayName: 'Jane Doe', role: 'participant', isVideoEnabled: true, isAudioEnabled: true },
  { id: '3', displayName: 'Bob Johnson', role: 'participant', isVideoEnabled: false, isAudioEnabled: true },
];

export const Default: Story = {
  args: {
    roomName: 'Physics 101: Gravity',
    // @ts-ignore
    localParticipant: participants[1],
    // @ts-ignore
    participants,
    isMuted: false,
    isVideoEnabled: true,
  },
};
