import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent } from '@testing-library/react';
import { LayoutSwitcher } from '../../components/composite/LayoutSwitcher';

describe('LayoutSwitcher', () => {
  it('renders all layout options', () => {
    const { getByLabelText } = render(<LayoutSwitcher layout="grid" onChange={() => {}} />);
    expect(getByLabelText('Switch to grid layout')).toBeDefined();
    expect(getByLabelText('Switch to spotlight layout')).toBeDefined();
    expect(getByLabelText('Switch to sidebar layout')).toBeDefined();
  });

  it('calls onChange when an option is clicked', () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<LayoutSwitcher layout="grid" onChange={onChange} />);
    fireEvent.click(getByLabelText('Switch to spotlight layout'));
    expect(onChange).toHaveBeenCalledWith('spotlight');
  });

  it('marks current layout as default variant (active)', () => {
    const { getByLabelText } = render(<LayoutSwitcher layout="grid" onChange={() => {}} />);
    expect(getByLabelText('Switch to grid layout')).toHaveClass('bg-[var(--chalk-bg-tertiary)]');
  });
});
