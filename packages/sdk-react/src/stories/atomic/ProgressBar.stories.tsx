import type { Meta, StoryObj } from '@storybook/react';
import { ProgressBar } from '../../components/atomic/ProgressBar';

const meta: Meta<typeof ProgressBar> = {
  title: 'Atomic/ProgressBar',
  component: ProgressBar,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'success', 'warning', 'danger'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
  args: {
    value: 60,
    showLabel: true,
  },
};

export const Success: Story = {
  args: {
    value: 100,
    variant: 'success',
    showLabel: true,
  },
};

export const Animated: Story = {
  args: {
    value: 45,
    animated: true,
    showLabel: true,
  },
};
