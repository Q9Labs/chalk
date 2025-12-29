import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { IconButton } from '../../components/atomic/IconButton';
import { Settings, X, MoreVertical } from 'lucide-react';

const meta: Meta<typeof IconButton> = {
  title: 'Atomic/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    variant: {
      control: 'select',
      options: ['default', 'ghost', 'outline'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Default: Story = {
  args: {
    icon: <Settings size={18} />,
    'aria-label': 'Settings',
  },
};

export const Ghost: Story = {
  args: {
    icon: <X size={18} />,
    variant: 'ghost',
    'aria-label': 'Close',
  },
};

export const Outline: Story = {
  args: {
    icon: <MoreVertical size={18} />,
    variant: 'outline',
    'aria-label': 'More',
  },
};
