/** Согласование существительного с числом: 1 вызов, 2 вызова, 5 вызовов. */
export function plural(count: number, one: string, few: string, many: string): string {
    const teen = Math.abs(count) % 100;
    if (teen >= 11 && teen <= 14) return many;
    const tail = Math.abs(count) % 10;
    if (tail === 1) return one;
    if (tail >= 2 && tail <= 4) return few;
    return many;
}

/** «вызов / вызова / вызовов» — самая частая форма в ленте событий. */
export const calls = (count: number): string => plural(count, 'вызов', 'вызова', 'вызовов');

/** «итерация / итерации / итераций». */
export const iterations = (count: number): string =>
    plural(count, 'итерация', 'итерации', 'итераций');
