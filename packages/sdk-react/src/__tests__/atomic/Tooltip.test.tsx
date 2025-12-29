import { describe, it, expect, vi } from 'bun:test';
import { render, fireEvent, act } from '@testing-library/react';
import { Tooltip } from '../../components/atomic/Tooltip';

describe('Tooltip', () => {
  it('renders children', () => {
    const { getByText } = render(
      <Tooltip content="Helper text">
        <button type="button">Hover me</button>
      </Tooltip>
    );
    expect(getByText('Hover me')).toBeDefined();
  });

  it('shows content on hover after delay', async () => {
    const { getByText, queryByText, getByRole } = render(
      <Tooltip content="Helper text" delay={100}>
        <button type="button">Hover me</button>
      </Tooltip>
    );
    
    fireEvent.mouseEnter(getByText('Hover me'));
    expect(queryByText('Helper text')).toBeNull();
    
    await new Promise(r => setTimeout(r, 150));
    
    expect(getByRole('tooltip')).toBeDefined();
    expect(getByText('Helper text')).toBeDefined();
  });

  it('hides content on mouse leave', async () => {
    const { getByText, queryByText } = render(
      <Tooltip content="Helper text" delay={0}>
        <button type="button">Hover me</button>
      </Tooltip>
    );
    
    const trigger = getByText('Hover me');
    fireEvent.mouseEnter(trigger);
    
    await new Promise(r => setTimeout(r, 50));
    
    expect(queryByText('Helper text')).toBeDefined();
    
    fireEvent.mouseLeave(trigger);
    expect(queryByText('Helper text')).toBeNull();
  });
});
