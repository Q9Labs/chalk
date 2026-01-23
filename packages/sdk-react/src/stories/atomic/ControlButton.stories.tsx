import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ControlButton } from '../../components/atomic/ControlButton';
import { Microphone01Icon, Video01Icon, Share01Icon, CallEnd01Icon } from '../../utils/icons';

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
    icon: <Microphone01Icon size={20} />,
    label: 'Mute',
    showLabel: true,
  },
};

export const Active: Story = {
  args: {
    icon: <Video01Icon size={20} />,
    label: 'Stop Video',
    active: true,
    showLabel: true,
  },
};

export const Danger: Story = {
  args: {
    icon: <CallEnd01Icon size={20} />,
    label: 'Leave',
    danger: true,
    showLabel: true,
  },
};

export const IconOnly: Story = {
  args: {
    icon: <Share01Icon size={20} />,
    label: 'Share Screen',
    showLabel: false,
  },
};
