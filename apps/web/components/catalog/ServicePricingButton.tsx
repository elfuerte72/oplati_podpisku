'use client';

import React from 'react';

import { comicButtonClassName } from '@/components/comic/ComicButton';
import { servicePricingUrl } from '@/lib/catalog/pricing-links';

type ServicePricingButtonProps = {
  slug: string | null | undefined;
  onOpenExternalLink: (url: string) => void;
};

export function ServicePricingButton({
  slug,
  onOpenExternalLink,
}: ServicePricingButtonProps) {
  const pricingUrl = servicePricingUrl(slug);
  if (!pricingUrl) return null;

  return (
    <button
      type="button"
      onClick={() => onOpenExternalLink(pricingUrl)}
      className={comicButtonClassName('surface', 'mt-4 w-full px-4 py-2.5 text-sm')}
    >
      Открыть прайс сервиса
    </button>
  );
}
