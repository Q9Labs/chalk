import type { Meta, StoryObj } from '@storybook/react';
import { Select } from '../../components/atomic/Select';

const meta: Meta<typeof Select> = {
  title: 'Atomic/Select',
  component: Select,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

const options = [
  { value: '1', label: 'Option 1' },
  { value: '2', label: 'Option 2' },
  { value: '3', label: 'Option 3' },
];

export const Default: Story = {
  args: {
    label: 'Select an option',
    options,
  },
};

export const WithPlaceholder: Story = {
  args: {
    label: 'Choose your device',
    placeholder: 'Select a camera...',
    options: [
      { value: 'cam1', label: 'FaceTime HD Camera' },
      { value: 'cam2', label: 'External USB Camera' },
    ],
  },
};

export const WithError: Story = {
  args: {
    label: 'Required selection',
    options,
    error: 'Please select an option to continue',
  },
};
