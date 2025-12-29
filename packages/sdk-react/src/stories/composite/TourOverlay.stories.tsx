import type { Meta, StoryObj } from '@storybook/react';
import { TourOverlay } from '../../components/composite/TourOverlay';

const meta: Meta<typeof TourOverlay> = {
  title: 'Composite/TourOverlay',
  component: TourOverlay,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TourOverlay>;

const steps = [
  { target: '#target-1', title: 'Step 1', content: 'Description 1' },
  { target: '#target-2', title: 'Step 2', content: 'Description 2' },
];

export const Default: Story = {
  args: {
    isOpen: true,
    steps,
    currentStep: 0,
    showProgress: true,
    showSkip: true,
  },
};
