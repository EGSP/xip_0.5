import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * Инструмент этапа 0.5: описание для модели плюс функция исполнения.
 *
 * Схема аргументов записана JSON Schema вручную. Порождение схемы из zod — задача следующего
 * этапа. Атрибутов вроде категории воздействия здесь намеренно нет: они нужны для уровней
 * автономии, которых на этом этапе не существует.
 *
 * Инструменты подобраны абстрактные: два недетерминированных (их результат нельзя угадать,
 * поэтому видно, что модель действительно вызывает инструмент, а не выдумывает ответ) и три
 * с общим состоянием в файле — на них проверяется цепочка из нескольких зависимых вызовов.
 */
export type Tool = {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<unknown>;
};

/** Единственный файл заметок. Лежит в рабочем каталоге программы. */
const NOTES_PATH = resolve(process.cwd(), 'notes.txt');

/** Предел объёма заметок. Малый предел нужен, чтобы модель столкнулась с отказом инструмента. */
const MAX_NOTES = 3;

async function readNotes(): Promise<string[]> {
    try {
        const raw = await readFile(NOTES_PATH, 'utf8');
        return raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw cause;
    }
}

function requireInteger(args: Record<string, unknown>, name: string, fallback?: number): number {
    const raw = args[name];
    if (raw === undefined && fallback !== undefined) return fallback;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Параметр "${name}" обязателен и должен быть целым числом`);
    }
    return Math.trunc(value);
}

const rollDice: Tool = {
    name: 'roll_dice',
    description:
        'Бросает игральные кубики и возвращает выпавшие значения и их сумму. ' +
        'Результат случаен, предсказать его нельзя — его обязательно нужно получить вызовом.',
    parameters: {
        type: 'object',
        properties: {
            count: { type: 'integer', description: 'Сколько кубиков бросить, от 1 до 10. По умолчанию 1.' },
            sides: { type: 'integer', description: 'Сколько граней у кубика, от 2 до 100. По умолчанию 6.' },
        },
        required: [],
    },
    async execute(args) {
        const count = requireInteger(args, 'count', 1);
        const sides = requireInteger(args, 'sides', 6);
        if (count < 1 || count > 10) throw new Error('Параметр "count" должен быть от 1 до 10');
        if (sides < 2 || sides > 100) throw new Error('Параметр "sides" должен быть от 2 до 100');

        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
        return { rolls, sum: rolls.reduce((total, value) => total + value, 0), sides };
    },
};

const randomNumber: Tool = {
    name: 'random_number',
    description:
        'Возвращает случайное целое число в заданном диапазоне включительно. ' +
        'Результат случаен, его нужно получить вызовом, а не придумать.',
    parameters: {
        type: 'object',
        properties: {
            min: { type: 'integer', description: 'Нижняя граница диапазона' },
            max: { type: 'integer', description: 'Верхняя граница диапазона' },
        },
        required: ['min', 'max'],
    },
    async execute(args) {
        const min = requireInteger(args, 'min');
        const max = requireInteger(args, 'max');
        if (min > max) throw new Error('Параметр "min" не может быть больше "max"');
        return { value: min + Math.floor(Math.random() * (max - min + 1)), min, max };
    },
};

const readNotesTool: Tool = {
    name: 'read_notes',
    description: 'Читает файл заметок и возвращает его строки. Если заметок нет, возвращает пустой список.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
        const lines = await readNotes();
        return { count: lines.length, limit: MAX_NOTES, lines };
    },
};

const writeNoteTool: Tool = {
    name: 'write_note',
    description:
        `Дописывает одну строку в файл заметок. В файле не может быть больше ${MAX_NOTES} строк: ` +
        'если предел достигнут, вызов отклоняется и нужно сначала очистить заметки.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Текст заметки, одна строка' },
        },
        required: ['text'],
    },
    async execute(args) {
        const text = args['text'];
        if (typeof text !== 'string' || text.trim() === '') {
            throw new Error('Параметр "text" обязателен и должен быть непустой строкой');
        }
        const line = text.replace(/\s+/g, ' ').trim();

        const lines = await readNotes();
        if (lines.length >= MAX_NOTES) {
            // Отказ инструмента — штатная ситуация. Текст написан так, чтобы модель поняла,
            // что делать дальше, а не повторяла тот же вызов.
            const error = new Error(
                `В заметках уже ${lines.length} строк из ${MAX_NOTES}, добавить нельзя. ` +
                    'Вызови clear_notes, если старые записи больше не нужны, и повтори запись.',
            );
            throw error;
        }

        const next = [...lines, line];
        await writeFile(NOTES_PATH, `${next.join('\n')}\n`, 'utf8');
        return { written: line, count: next.length, limit: MAX_NOTES };
    },
};

const clearNotesTool: Tool = {
    name: 'clear_notes',
    description: 'Полностью очищает файл заметок. Операция необратима.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
        const before = (await readNotes()).length;
        await writeFile(NOTES_PATH, '', 'utf8');
        return { cleared: before };
    },
};

export const tools: readonly Tool[] = [
    rollDice,
    randomNumber,
    readNotesTool,
    writeNoteTool,
    clearNotesTool,
];

/** Поиск инструмента по имени, которое назвала модель. */
export const toolByName = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));

/** Описания инструментов в том виде, в каком они отправляются модели. */
export const toolSpecs: readonly ChatCompletionTool[] = tools.map((tool) => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    },
}));
