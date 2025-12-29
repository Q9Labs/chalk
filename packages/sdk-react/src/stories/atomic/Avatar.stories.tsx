import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from '../../components/atomic/Avatar';

const meta: Meta<typeof Avatar> = {
  title: 'Atomic/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    status: {
      control: 'select',
      options: ['online', 'away', 'busy', 'offline'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Default: Story = {
  args: {
    name: 'John Smith',
    size: 'md',
  },
};

export const WithImage: Story = {
  args: {
    name: 'John Smith',
    src: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80',
    size: 'lg',
  },
};

export const WithStatus: Story = {
  args: {
    name: 'John Smith',
    status: 'online',
    size: 'md',
  },
};
