import type { ReactNode } from 'react';

export function SectionHeading({
  step,
  title,
  description,
  children,
}: {
  step: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <span className="step">{step}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
