import type { Meta, StoryObj } from '@storybook/react';
import { HandRaiseIndicator } from '../../components/atomic/HandRaiseIndicator';

const meta: Meta<typeof HandRaiseIndicator> = {
  title: 'Atomic/HandRaiseIndicator',
  component: HandRaiseIndicator,
  tags: ['autodocs'],
  argTypes: {
    position: {
      control: 'select',
      options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof HandRaiseIndicator>;

export const Raised: Story = {
  args: {
    raised: true,
    animated: true,
  },
};

export const Static: Story = {
  args: {
    raised: true,
    animated: false,
  },
};
