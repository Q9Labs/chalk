import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { NameTag } from '../../components/atomic/NameTag';

describe('NameTag', () => {
  it('renders name correctly', () => {
    const { getByText } = render(<NameTag name="Alice" />);
    expect(getByText('Alice')).toBeDefined();
  });

  it('renders (You) for local participant', () => {
    const { getByText } = render(<NameTag name="Alice" isLocal />);
    expect(getByText('(You)')).toBeDefined();
  });

  it('renders role for host', () => {
    const { getByText } = render(<NameTag name="Alice" {...({ role: 'host' } as any)} />);
    expect(getByText('host')).toBeDefined();
  });

  it('renders role for co-host', () => {
    const { getByText } = render(<NameTag name="Alice" {...({ role: 'co-host' } as any)} />);
    expect(getByText('co-host')).toBeDefined();
  });

  it('does not render role for participant', () => {
    const { queryByText } = render(<NameTag name="Alice" {...({ role: 'participant' } as any)} />);
    expect(queryByText('PARTICIPANT')).toBeNull();
  });

  it('applies size classes', () => {
    const { container } = render(<NameTag name="Alice" size="lg" />);
    expect(container.firstChild).toHaveClass('text-base');
  });
});
