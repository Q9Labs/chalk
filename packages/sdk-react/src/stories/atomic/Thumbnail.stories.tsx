import type { Meta, StoryObj } from '@storybook/react';
import { Thumbnail } from '../../components/atomic/Thumbnail';

const meta: Meta<typeof Thumbnail> = {
  title: 'Atomic/Thumbnail',
  component: Thumbnail,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Thumbnail>;

export const Default: Story = {
  args: {
    size: 'md',
  },
};

export const Active: Story = {
  args: {
    size: 'md',
    active: true,
  },
};

export const Muted: Story = {
  args: {
    size: 'md',
    muted: true,
  },
};
