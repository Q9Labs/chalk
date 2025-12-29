import type { Meta, StoryObj } from '@storybook/react';
import { ConnectionLostOverlay } from '../../components/composite/ConnectionLostOverlay';

const meta: Meta<typeof ConnectionLostOverlay> = {
  title: 'Composite/ConnectionLostOverlay',
  component: ConnectionLostOverlay,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ConnectionLostOverlay>;

export const Reconnecting: Story = {
  args: {
    isVisible: true,
    status: 'reconnecting',
  },
};

export const Failed: Story = {
  args: {
    isVisible: true,
    status: 'failed',
    message: 'Your connection has timed out. Please check your internet.',
  },
};
