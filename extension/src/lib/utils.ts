import { clsx, type ClassValue } from 'clsx';
import { createContext, useContext } from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/**
 * Куда компонентам отправлять свои порталы.
 *
 * Base UI умеет портировать popup не только в <body>, но и в ShadowRoot — это
 * прямо в типе `container`. У Radix там только HTMLElement, и попытка отдать
 * shadow root была бы вне контракта.
 *
 * В боковой панели контекст пустой (свой документ, портал в body работает штатно).
 * В оверлее сюда кладётся shadow root — тогда всплывашки не вылетают наружу
 * и не теряют стили. Провайдер написан заранее, чтобы дверь для компонентов
 * с порталами в оверлее осталась открытой.
 */
export const ShadowRootContext = createContext<ShadowRoot | null>(null);
export const usePortalContainer = () => useContext(ShadowRootContext);
