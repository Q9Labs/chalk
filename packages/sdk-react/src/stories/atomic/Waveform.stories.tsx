import type { Meta, StoryObj } from '@storybook/react';
import { Waveform } from '../../components/atomic/Waveform';

const meta: Meta<typeof Waveform> = {
  title: 'Atomic/Waveform',
  component: Waveform,
  tags: ['autodocs'],
  argTypes: {
    barCount: {
      control: { type: 'number', min: 10, max: 100 },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Waveform>;

export const Default: Story = {
  args: {
    levels: Array.from({ length: 40 }, () => Math.random() * 100),
    animated: true,
  },
};

export const Static: Story = {
  args: {
    levels: [10, 20, 30, 40, 50, 40, 30, 20, 10],
    animated: false,
  },
};
