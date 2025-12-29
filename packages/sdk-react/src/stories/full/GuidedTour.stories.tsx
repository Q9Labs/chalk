import type { Meta, StoryObj } from '@storybook/react';
import { GuidedTour } from '../../components/full/GuidedTour';

const meta: Meta<typeof GuidedTour> = {
  title: 'Full/GuidedTour',
  component: GuidedTour,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof GuidedTour>;

export const Default: Story = {
  args: {
    isOpen: true,
    onComplete: () => console.log('Tour completed'),
    showProgress: true,
    showSkip: true,
  },
};
