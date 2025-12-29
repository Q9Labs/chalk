import type { Meta, StoryObj } from '@storybook/react';
import { NameTag } from '../../components/atomic/NameTag';

const meta: Meta<typeof NameTag> = {
  title: 'Atomic/NameTag',
  component: NameTag,
  tags: ['autodocs'],
  argTypes: {
    role: {
      control: 'select',
      options: ['host', 'co-host', 'participant'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof NameTag>;

export const Default: Story = {
  args: {
    name: 'Jane Doe',
    size: 'md',
  },
};

export const Host: Story = {
  args: {
    name: 'Jane Doe',
    role: 'host',
    size: 'md',
  },
};

export const Local: Story = {
  args: {
    name: 'Jane Doe',
    isLocal: true,
    size: 'md',
  },
};
