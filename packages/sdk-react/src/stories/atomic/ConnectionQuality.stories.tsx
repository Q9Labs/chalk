import type { Meta, StoryObj } from '@storybook/react';
import { ConnectionQuality } from '../../components/atomic/ConnectionQuality';

const meta: Meta<typeof ConnectionQuality> = {
  title: 'Atomic/ConnectionQuality',
  component: ConnectionQuality,
  tags: ['autodocs'],
  argTypes: {
    quality: {
      control: { type: 'number', min: 1, max: 4 },
    },
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof ConnectionQuality>;

export const Excellent: Story = {
  args: {
    quality: 4,
    showLabel: true,
  },
};

export const Good: Story = {
  args: {
    quality: 3,
    showLabel: true,
  },
};

export const Fair: Story = {
  args: {
    quality: 2,
    showLabel: true,
  },
};

export const Poor: Story = {
  args: {
    quality: 1,
    showLabel: true,
  },
};
