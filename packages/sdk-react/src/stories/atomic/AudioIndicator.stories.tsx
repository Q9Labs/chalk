import type { Meta, StoryObj } from '@storybook/react';
import { AudioIndicator } from '../../components/atomic/AudioIndicator';

const meta: Meta<typeof AudioIndicator> = {
  title: 'Atomic/AudioIndicator',
  component: AudioIndicator,
  tags: ['autodocs'],
  argTypes: {
    level: {
      control: { type: 'range', min: 0, max: 100 },
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    variant: {
      control: 'select',
      options: ['bars', 'icon', 'dot'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof AudioIndicator>;

export const Icon: Story = {
  args: {
    variant: 'icon',
    level: 50,
  },
};

export const Bars: Story = {
  args: {
    variant: 'bars',
    level: 75,
  },
};

export const Dot: Story = {
  args: {
    variant: 'dot',
    level: 10,
  },
};

export const Muted: Story = {
  args: {
    variant: 'icon',
    muted: true,
  },
};
