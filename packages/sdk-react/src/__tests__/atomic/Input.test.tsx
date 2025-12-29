import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../../components/atomic/Input';

describe('Input', () => {
  it('renders correctly with label', () => {
    const { getByText, getByPlaceholderText } = render(<Input label="Username" placeholder="Enter username" />);
    expect(getByText('Username')).toBeDefined();
    expect(getByPlaceholderText('Enter username')).toBeDefined();
  });

  it('handles change events', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(<Input placeholder="Enter username" onChange={onChange} />);
    const input = getByPlaceholderText('Enter username') as HTMLInputElement;
    await user.type(input, 'a');
    expect(onChange).toHaveBeenCalled();
  });

  it('displays error message', () => {
    const { getByText } = render(<Input label="Username" error="Field is required" />);
    expect(getByText('Field is required')).toBeDefined();
  });

  it('renders icons', () => {
    const icon = <span data-testid="test-icon">🔍</span>;
    const { getByTestId } = render(<Input label="Search" icon={icon} iconPosition="left" />);
    expect(getByTestId('test-icon')).toBeDefined();
  });

  it('can be disabled', () => {
    const { getByPlaceholderText } = render(<Input placeholder="Enter username" disabled />);
    expect(getByPlaceholderText('Enter username')).toBeDisabled();
  });
});
