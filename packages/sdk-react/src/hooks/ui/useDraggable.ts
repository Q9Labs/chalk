export function useDraggable(..._args: any[]): any {
  return { ref: { current: null }, position: { x: 0, y: 0 }, isDragging: false, handlers: {}, dragHandlers: {} };
}
