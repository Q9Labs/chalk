import type { Meta, StoryObj } from '@storybook/react';
import { ControlBar } from '../../components/composite/ControlBar';

const meta: Meta<typeof ControlBar> = {
  title: 'Composite/ControlBar',
  component: ControlBar,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['floating', 'fixed', 'minimal'],
    },
    position: {
      control: 'select',
      options: ['bottom', 'top'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof ControlBar>;

export const Floating: Story = {
  args: {
    variant: 'floating',
    position: 'bottom',
    showLabels: true,
    isMuted: false,
    isVideoEnabled: true,
    isScreenSharing: false,
    isRecording: false,
  },
};

export const Fixed: Story = {
  args: {
    variant: 'fixed',
    position: 'bottom',
    showLabels: false,
    isMuted: true,
    isVideoEnabled: false,
    isScreenSharing: true,
    isRecording: true,
  },
};

export const Minimal: Story = {
  args: {
    variant: 'minimal',
    position: 'bottom',
    isMuted: false,
    isVideoEnabled: true,
  },
};
