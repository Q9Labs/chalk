import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from '../../components/atomic/Badge';
import { Mail } from 'lucide-react';

const meta: Meta<typeof Badge> = {
  title: 'Atomic/Badge',
  component: Badge,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'primary', 'success', 'warning', 'danger'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Default: Story = {
  args: {
    count: 5,
    children: <Mail size={24} />,
  },
};

export const Primary: Story = {
  args: {
    count: 99,
    variant: 'primary',
    children: <div className="w-10 h-10 bg-[var(--chalk-bg-secondary)] rounded-md" />,
  },
};

export const MaxValue: Story = {
  args: {
    count: 150,
    max: 99,
    variant: 'danger',
    children: <Mail size={24} />,
  },
};

export const Dot: Story = {
  args: {
    dot: true,
    variant: 'success',
    children: <Mail size={24} />,
  },
};
