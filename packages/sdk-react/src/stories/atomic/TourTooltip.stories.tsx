import type { Meta, StoryObj } from '@storybook/react';
import { TourTooltip } from '../../components/atomic/TourTooltip';

const meta: Meta<typeof TourTooltip> = {
  title: 'Atomic/TourTooltip',
  component: TourTooltip,
  tags: ['autodocs'],
  argTypes: {
    placement: {
      control: 'select',
      options: ['top', 'bottom', 'left', 'right'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof TourTooltip>;

export const Default: Story = {
  args: {
    title: 'Control Bar',
    description: 'Use these buttons to toggle your audio and video, or share your screen.',
    step: 1,
    totalSteps: 5,
    showProgress: true,
  },
};

export const WithSkip: Story = {
  args: {
    title: 'Welcome!',
    description: 'Let us show you around the new classroom interface.',
    step: 0,
    totalSteps: 5,
    showSkip: true,
  },
};
