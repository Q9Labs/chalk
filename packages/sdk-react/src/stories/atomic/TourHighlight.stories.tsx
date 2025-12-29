import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TourHighlight } from '../../components/atomic/TourHighlight';

const meta: Meta<typeof TourHighlight> = {
  title: 'Atomic/TourHighlight',
  component: TourHighlight,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TourHighlight>;

export const Default: Story = {
  render: () => (
    <div className="p-20 relative">
      <div id="target-element" className="w-32 h-32 bg-[var(--chalk-accent)] rounded-lg flex items-center justify-center text-white">
        Target
      </div>
      <TourHighlight targetSelector="#target-element" />
    </div>
  ),
};
