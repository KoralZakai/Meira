// Thin wrapper around dnd-kit's useSortable so screens stay readable. Render a
// single sortable row; the drag handle is the whole element.
import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function SortableRow({
  id,
  children,
  className,
}: {
  id: string;
  children: (dragging: boolean) => ReactNode;
  className?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={className}
      {...attributes}
      {...listeners}
    >
      {children(isDragging)}
    </div>
  );
}
