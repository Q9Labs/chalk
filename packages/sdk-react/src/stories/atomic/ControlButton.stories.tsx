import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ControlButton } from '../../components/atomic/ControlButton';
import { Mic, Video, Share, PhoneOff } from 'lucide-react';

const meta: Meta<typeof ControlButton> = {
  title: 'Atomic/ControlButton',
  component: ControlButton,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof ControlButton>;

export const Default: Story = {
  args: {
    icon: <Mic size={20} />,
    label: 'Mute',
    showLabel: true,
  },
};

export const Active: Story = {
  args: {
    icon: <Video size={20} />,
    label: 'Stop Video',
    active: true,
    showLabel: true,
  },
};

export const Danger: Story = {
  args: {
    icon: <PhoneOff size={20} />,
    label: 'Leave',
    danger: true,
    showLabel: true,
  },
};

export const IconOnly: Story = {
  args: {
    icon: <Share size={20} />,
    label: 'Share Screen',
    showLabel: false,
  },
};
