import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { IconButton } from '../../components/atomic/IconButton';
import { Settings01Icon, Cancel01Icon, MoreVerticalIcon } from '../../utils/icons';

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
    icon: <Settings01Icon size={18} />,
    'aria-label': 'Settings',
  },
};

export const Ghost: Story = {
  args: {
    icon: <Cancel01Icon size={18} />,
    variant: 'ghost',
    'aria-label': 'Close',
  },
};

export const Outline: Story = {
  args: {
    icon: <MoreVerticalIcon size={18} />,
    variant: 'outline',
    'aria-label': 'More',
  },
};
