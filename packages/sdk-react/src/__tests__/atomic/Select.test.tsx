import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { Select } from '../../components/atomic/Select';

describe('Select', () => {
  const options = [
    { value: '1', label: 'Option 1' },
    { value: '2', label: 'Option 2' },
  ];

  it('renders correctly with label', () => {
    const { getByLabelText, getByText } = render(<Select label="My Select" options={options} />);
    const trigger = getByLabelText('My Select');
    expect(trigger).toBeDefined();
    expect(getByText('My Select')).toBeDefined();
  });

  it('handles change events', () => {
    const onChange = vi.fn();
    const { getByLabelText, getByRole, getByText, queryByRole } = render(
      <Select label="My Select" options={options} onChange={onChange} />
    );

    const trigger = getByLabelText('My Select');
    fireEvent.click(trigger);

    expect(getByRole('listbox')).toBeDefined();
    fireEvent.click(getByText('Option 2'));

    expect(onChange).toHaveBeenCalledWith({ target: { value: '2' } });
    expect(queryByRole('listbox')).toBeNull();
  });

  it('renders placeholder', () => {
    const { getByText } = render(<Select options={options} placeholder="Select an option" />);
    expect(getByText('Select an option')).toBeDefined();
  });

  it('displays error message', () => {
    const { getByText } = render(<Select options={options} error="Selection required" />);
    expect(getByText('Selection required')).toBeDefined();
  });

  it('can be disabled', () => {
    const { getByRole } = render(<Select options={options} disabled />);
    expect(getByRole('button')).toBeDisabled();
  });
});
