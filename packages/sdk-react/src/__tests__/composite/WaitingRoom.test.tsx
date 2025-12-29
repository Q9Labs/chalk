import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { WaitingRoom } from '../../components/composite/WaitingRoom';

describe('WaitingRoom', () => {
  const participants = [
    { id: '1', displayName: 'Alice', joinedAt: new Date() },
  ];

  it('renders correctly', () => {
    const { getByText } = render(
      <WaitingRoom participants={participants} onAdmit={() => {}} onDeny={() => {}} />
    );
    expect(getByText('Waiting Room')).toBeDefined();
    expect(getByText('Alice')).toBeDefined();
    expect(getByText(/Waiting for Just now/i)).toBeDefined();
  });

  it('calls onAdmit when check button clicked', () => {
    const onAdmit = vi.fn();
    const { getByLabelText } = render(
      <WaitingRoom participants={participants} onAdmit={onAdmit} onDeny={() => {}} />
    );
    fireEvent.click(getByLabelText('Admit Alice'));
    expect(onAdmit).toHaveBeenCalledWith('1');
  });

  it('shows empty message when no one is waiting', () => {
    const { getByText } = render(
      <WaitingRoom participants={[]} onAdmit={() => {}} onDeny={() => {}} />
    );
    expect(getByText('No one is waiting')).toBeDefined();
  });
});
