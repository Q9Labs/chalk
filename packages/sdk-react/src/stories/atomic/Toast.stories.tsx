import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from '../../components/atomic/Toast';

const meta: Meta<typeof Toast> = {
  title: 'Atomic/Toast',
  component: Toast,
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'select',
      options: ['info', 'success', 'warning', 'error'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Toast>;

export const Info: Story = {
  args: {
    message: 'Recording has started',
    type: 'info',
  },
};

export const Success: Story = {
  args: {
    message: 'Profile updated successfully',
    type: 'success',
  },
};

export const WithAction: Story = {
  args: {
    message: 'Connection lost. Reconnecting...',
    type: 'warning',
    action: {
      label: 'Retry',
      onClick: () => console.log('Retry clicked'),
    },
  },
};
