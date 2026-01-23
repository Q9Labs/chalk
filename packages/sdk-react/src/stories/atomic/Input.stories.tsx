import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Input } from '../../components/atomic/Input';
import { Mail01Icon, Search01Icon } from '../../utils/icons';

const meta: Meta<typeof Input> = {
  title: 'Atomic/Input',
  component: Input,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: {
    placeholder: 'Enter your name',
    label: 'Name',
  },
};

export const WithIcon: Story = {
  args: {
    placeholder: 'Search...',
    icon: <Search01Icon size={18} />,
    iconPosition: 'left',
  },
};

export const WithError: Story = {
  args: {
    label: 'Email',
    placeholder: 'email@example.com',
    icon: <Mail01Icon size={18} />,
    error: 'Please enter a valid email address',
  },
};
