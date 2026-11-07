import type {
  InventoryDefinition,
  InventoryItemDefinition,
  InventoryService,
  InventorySlot,
  InventoryState,
  EquipmentState,
} from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Item = Required<InventoryItemDefinition>;
type Inventory = { id: string; owner: string; slots: (InventorySlot | null)[] };
type Equipment = { id: string; owner: string; slots: { id: string; requiredTag?: string; item: string | null }[] };
type InventorySnapshot = { format: "pelican.inventory"; version: 1; items: Item[]; inventories: Inventory[]; equipment?: Equipment[] };
const MAX_ITEMS = 4096, MAX_INVENTORIES = 512, MAX_SLOTS = 65536, MAX_CAPACITY = 256, MAX_STACK = 1_000_000;
const fail = (code: string, message: string): never => { throw new Error(`TC_INVENTORY_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const keys = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const amount = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("COUNT", "Count must be a positive safe integer.");
  return value as number;
};
const copySlots = (slots: readonly (InventorySlot | null)[]) => slots.map(slot => slot ? { ...slot } : null);
function itemDefinition(input: InventoryItemDefinition): Item {
  if (!keys(input, ["id", "maxStack", "label", "tags"]) || !validName(input.id))
    return fail("ITEM", "Item needs a nonempty printable id of at most 64 characters.");
  const maxStack = input.maxStack === undefined ? 1 : input.maxStack;
  const label = input.label === undefined ? input.id : input.label;
  const tags = input.tags === undefined ? [] : input.tags;
  if (!Number.isSafeInteger(maxStack) || maxStack < 1 || maxStack > MAX_STACK ||
      typeof label !== "string" || label.length > 256 || !Array.isArray(tags) || tags.length > 16 ||
      tags.some(tag => !validName(tag)) || new Set(tags).size !== tags.length)
    return fail("ITEM", `Item '${input.id}' needs maxStack in 1..${MAX_STACK}, a label of at most 256 characters and up to 16 distinct printable tags.`);
  return { id: input.id, maxStack, label, tags: [...tags] };
}
function containerDefinition(input: InventoryDefinition): Inventory {
  if (!keys(input, ["id", "owner", "capacity"]) || !validName(input.id) || !validName(input.owner) ||
      !Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > MAX_CAPACITY)
    return fail("DEFINITION", `Inventory needs printable id/owner and capacity in 1..${MAX_CAPACITY}.`);
  return { id: input.id, owner: input.owner, slots: Array.from({ length: input.capacity }, () => null) };
}
function addTo(slots: (InventorySlot | null)[], item: Item, count: number): void {
  let remaining = count;
  for (const slot of slots) {
    if (!slot || slot.item !== item.id) continue;
    const added = Math.min(remaining, item.maxStack - slot.count);
    slot.count += added; remaining -= added;
    if (!remaining) return;
  }
  for (let i = 0; i < slots.length && remaining; i++) {
    if (slots[i] !== null) continue;
    const added = Math.min(remaining, item.maxStack);
    slots[i] = { item: item.id, count: added }; remaining -= added;
  }
  if (remaining) return fail("FULL", `Not enough free stack capacity for '${item.id}'; free slots or transfer fewer items.`);
}
function removeFrom(slots: (InventorySlot | null)[], item: string, count: number): void {
  let remaining = count;
  for (let i = 0; i < slots.length && remaining; i++) {
    const slot = slots[i];
    if (!slot || slot.item !== item) continue;
    const removed = Math.min(remaining, slot.count);
    slot.count -= removed; remaining -= removed;
    if (!slot.count) slots[i] = null;
  }
  if (remaining) return fail("INSUFFICIENT", `Not enough '${item}'; reduce the requested count.`);
}
function parse(value: unknown): { items: Map<string, Item>; inventories: Map<string, Inventory>; equipment: Map<string, Equipment> } {
  const snapshot = cloneSerializable(value) as InventorySnapshot;
  if (!keys(snapshot, ["format", "version", "items", "inventories", "equipment"]) || snapshot.format !== "pelican.inventory" || snapshot.version !== 1 ||
      !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS || !Array.isArray(snapshot.inventories) || snapshot.inventories.length > MAX_INVENTORIES ||
      (snapshot.equipment !== undefined && (!Array.isArray(snapshot.equipment) || snapshot.equipment.length > MAX_INVENTORIES)))
    return fail("SNAPSHOT", "Expected a bounded version 1 inventory snapshot.");
  const items = new Map<string, Item>();
  for (const raw of snapshot.items) {
    const item = itemDefinition(raw);
    if (items.has(item.id)) return fail("SNAPSHOT", `Duplicate item '${item.id}'.`);
    items.set(item.id, item);
  }
  const inventories = new Map<string, Inventory>();
  let total = 0;
  for (const raw of snapshot.inventories) {
    if (!keys(raw, ["id", "owner", "slots"]) || !validName(raw.id) || !validName(raw.owner) || !Array.isArray(raw.slots) ||
        raw.slots.length < 1 || raw.slots.length > MAX_CAPACITY || inventories.has(raw.id))
      return fail("SNAPSHOT", "Invalid or duplicate inventory record.");
    const slots: (InventorySlot | null)[] = raw.slots.map((slot: unknown) => {
      if (slot === null) return null;
      if (!keys(slot, ["item", "count"]) || !validName(slot.item) || !items.has(slot.item) ||
          !Number.isSafeInteger(slot.count) || (slot.count as number) < 1 || (slot.count as number) > items.get(slot.item)!.maxStack)
        return fail("SNAPSHOT", `Invalid stack in inventory '${raw.id}'.`);
      return { item: slot.item, count: slot.count as number };
    });
    total += slots.length;
    if (total > MAX_SLOTS) return fail("CAPACITY", `At most ${MAX_SLOTS} slots may be restored.`);
    inventories.set(raw.id, { id: raw.id, owner: raw.owner, slots });
  }
  const equipment = new Map<string, Equipment>();
  for (const entry of snapshot.equipment ?? []) {
    if (!keys(entry, ["id", "owner", "slots"]) || !validName(entry.id) || !validName(entry.owner) || equipment.has(entry.id) ||
        !Array.isArray(entry.slots) || entry.slots.length < 1 || entry.slots.length > MAX_CAPACITY)
      return fail("SNAPSHOT", "Invalid equipment record.");
    const seen = new Set<string>();
    for (const slot of entry.slots) {
      if (!keys(slot, ["id", "requiredTag", "item"]) || !validName(slot.id) || seen.has(slot.id) ||
          (slot.requiredTag !== undefined && !validName(slot.requiredTag)) ||
          (slot.item !== null && (!validName(slot.item) || !items.has(slot.item) || (slot.requiredTag !== undefined && !items.get(slot.item)!.tags.includes(slot.requiredTag)))))
        return fail("SNAPSHOT", `Invalid equipment slot in '${entry.id}'.`);
      seen.add(slot.id);
    }
    total += entry.slots.length;
    if (total > MAX_SLOTS) return fail("CAPACITY", `At most ${MAX_SLOTS} total slots may be restored.`);
    equipment.set(entry.id, entry);
  }
  return { items, inventories, equipment };
}
export const createInventoryPlugin: RuntimePluginFactory = () => {
  let items = new Map<string, Item>(), inventories = new Map<string, Inventory>(), equipment = new Map<string, Equipment>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using inventory."); };
  const getItem = (id: string): Item => {
    alive();
    if (!validName(id)) return fail("ITEM", "Expected a nonempty item id.");
    return items.get(id) ?? fail("ITEM_MISSING", `Item '${id}' is not defined.`);
  };
  const get = (id: string): Inventory => {
    alive();
    if (!validName(id)) return fail("DEFINITION", "Expected a nonempty inventory id.");
    return inventories.get(id) ?? fail("MISSING", `Inventory '${id}' does not exist.`);
  };
  const slotIndex = (inventory: Inventory, value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= inventory.slots.length)
      return fail("SLOT", `Slot index must be within inventory '${inventory.id}'.`);
    return value;
  };
  const getEquipment = (id: string): Equipment => {
    alive();
    if (!validName(id)) return fail("EQUIPMENT", "Expected an equipment id.");
    return equipment.get(id) ?? fail("EQUIPMENT_MISSING", `Equipment '${id}' does not exist.`);
  };
  const equipmentSlot = (entry: Equipment, id: string) => entry.slots.find(slot => slot.id === id) ?? fail("EQUIPMENT_SLOT", `Equipment '${entry.id}' has no slot '${String(id)}'.`);
  const service: InventoryService = {
    defineItem(input) {
      alive();
      const item = itemDefinition(cloneSerializable(input));
      if (items.has(item.id)) return fail("ITEM_DUPLICATE", `Item '${item.id}' is already defined.`);
      if (items.size >= MAX_ITEMS) return fail("CAPACITY", `At most ${MAX_ITEMS} items may be defined.`);
      items.set(item.id, item);
    },
    getItem(id) { return cloneSerializable(getItem(id)); },
    listItems() { alive(); return cloneSerializable([...items.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); },
    undefineItem(id) {
      getItem(id);
      for (const inventory of inventories.values())
        if (inventory.slots.some(slot => slot?.item === id)) return fail("ITEM_IN_USE", `Remove all '${id}' stacks before undefining the item.`);
      for (const entry of equipment.values())
        if (entry.slots.some(slot => slot.item === id)) return fail("ITEM_IN_USE", `Unequip '${id}' before undefining the item.`);
      items.delete(id);
    },
    create(input) {
      alive();
      const inventory = containerDefinition(cloneSerializable(input));
      if (inventories.has(inventory.id)) return fail("DUPLICATE", `Inventory '${inventory.id}' already exists.`);
      const currentSlots = [...inventories.values(), ...equipment.values()].reduce((sum, value) => sum + value.slots.length, 0);
      if (inventories.size >= MAX_INVENTORIES || currentSlots + inventory.slots.length > MAX_SLOTS)
        return fail("CAPACITY", `At most ${MAX_INVENTORIES} inventories and ${MAX_SLOTS} total slots are supported.`);
      inventories.set(inventory.id, inventory);
    },
    inspect(id): InventoryState { const inventory = get(id); return { id: inventory.id, owner: inventory.owner, slots: copySlots(inventory.slots) }; },
    count(id, item) {
      const inventory = get(id); getItem(item);
      return inventory.slots.reduce((sum, slot) => sum + (slot?.item === item ? slot.count : 0), 0);
    },
    add(id, itemId, requested) {
      const inventory = get(id), item = getItem(itemId), count = amount(requested), slots = copySlots(inventory.slots);
      addTo(slots, item, count);
      inventory.slots = slots;
    },
    remove(id, itemId, requested) {
      const inventory = get(id); getItem(itemId);
      const count = amount(requested), slots = copySlots(inventory.slots);
      removeFrom(slots, itemId, count);
      inventory.slots = slots;
    },
    transfer(from, to, itemId, requested) {
      const source = get(from), destination = get(to), item = getItem(itemId), count = amount(requested);
      const sourceSlots = copySlots(source.slots);
      removeFrom(sourceSlots, itemId, count);
      if (source === destination) return;
      const destinationSlots = copySlots(destination.slots);
      addTo(destinationSlots, item, count);
      source.slots = sourceSlots; destination.slots = destinationSlots;
    },
    moveSlot(id, from, to, requested) {
      const inventory = get(id), a = slotIndex(inventory, from), b = slotIndex(inventory, to), slots = copySlots(inventory.slots);
      const source = slots[a];
      if (!source) return fail("SLOT_EMPTY", `Slot ${a} of '${id}' is empty.`);
      const count = requested === undefined ? source.count : amount(requested);
      if (count > source.count) return fail("INSUFFICIENT", `Slot ${a} holds only ${source.count} items.`);
      if (a === b) return;
      const target = slots[b];
      if (!target) {
        slots[b] = { item: source.item, count };
        source.count -= count;
        if (!source.count) slots[a] = null;
      } else if (target.item === source.item) {
        if (target.count + count > getItem(source.item).maxStack) return fail("FULL", `Slot ${b} cannot hold the full amount.`);
        target.count += count; source.count -= count;
        if (!source.count) slots[a] = null;
      } else {
        if (count !== source.count) return fail("SLOT_SWAP", "A swap requires the entire source stack.");
        slots[a] = target; slots[b] = source;
      }
      inventory.slots = slots;
    },
    createEquipment(id, owner, input) {
      alive();
      const slots = cloneSerializable(input);
      if (!validName(id) || !validName(owner) || !Array.isArray(slots) || slots.length < 1 || slots.length > MAX_CAPACITY)
        return fail("EQUIPMENT", `Equipment needs printable id/owner and 1..${MAX_CAPACITY} slots.`);
      if (equipment.has(id)) return fail("EQUIPMENT_DUPLICATE", `Equipment '${id}' already exists.`);
      const seen = new Set<string>();
      for (const slot of slots) {
        if (!keys(slot, ["id", "requiredTag"]) || !validName(slot.id) || seen.has(slot.id) ||
            (slot.requiredTag !== undefined && !validName(slot.requiredTag))) return fail("EQUIPMENT_SLOT", "Slot ids must be unique; requiredTag must be printable.");
        seen.add(slot.id);
      }
      const total = [...inventories.values(), ...equipment.values()].reduce((sum, value) => sum + value.slots.length, 0);
      if (equipment.size >= MAX_INVENTORIES || total + slots.length > MAX_SLOTS) return fail("CAPACITY", "Equipment or total slot capacity exceeded.");
      equipment.set(id, { id, owner, slots: slots.map(slot => ({ id: slot.id, ...(slot.requiredTag === undefined ? {} : { requiredTag: slot.requiredTag }), item: null })) });
    },
    inspectEquipment(id): EquipmentState { return cloneSerializable(getEquipment(id)); },
    equip(id, slotId, inventoryId, itemId) {
      const entry = getEquipment(id), slot = equipmentSlot(entry, slotId), inventory = get(inventoryId), item = getItem(itemId);
      if (entry.owner !== inventory.owner) return fail("OWNER", "Equipment and inventory must have the same owner.");
      if (slot.requiredTag !== undefined && !item.tags.includes(slot.requiredTag)) return fail("EQUIPMENT_TAG", `Item '${itemId}' requires tag '${slot.requiredTag}' for slot '${slotId}'.`);
      const slots = copySlots(inventory.slots);
      removeFrom(slots, itemId, 1);
      if (slot.item !== null) addTo(slots, getItem(slot.item), 1);
      inventory.slots = slots; slot.item = itemId;
    },
    unequip(id, slotId, inventoryId) {
      const entry = getEquipment(id), slot = equipmentSlot(entry, slotId), inventory = get(inventoryId);
      if (entry.owner !== inventory.owner) return fail("OWNER", "Equipment and inventory must have the same owner.");
      if (slot.item === null) return fail("EQUIPMENT_EMPTY", `Equipment slot '${slotId}' is empty.`);
      const slots = copySlots(inventory.slots);
      addTo(slots, getItem(slot.item), 1);
      inventory.slots = slots; slot.item = null;
    },
    destroyEquipment(id) {
      const entry = getEquipment(id);
      if (entry.slots.some(slot => slot.item !== null)) return fail("EQUIPMENT_IN_USE", `Unequip all items before destroying '${id}'.`);
      equipment.delete(id);
    },
    destroy(id) { get(id); inventories.delete(id); },
    destroyOwner(owner) {
      alive();
      if (!validName(owner)) return fail("OWNER", "Expected a nonempty owner.");
      for (const [id, inventory] of inventories) if (inventory.owner === owner) inventories.delete(id);
      for (const [id, entry] of equipment) if (entry.owner === owner) equipment.delete(id);
    },
  };
  const empty = (): InventorySnapshot => ({ format: "pelican.inventory", version: 1, items: [], inventories: [] });
  return {
    id: "$engine.inventory", version: "1", services: { inventory: service },
    snapshot() {
      alive();
      return cloneSerializable({ format: "pelican.inventory", version: 1,
        items: [...items.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        inventories: [...inventories.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        equipment: [...equipment.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
    },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    restore(value) { alive(); const next = parse(value); items = next.items; inventories = next.inventories; equipment = next.equipment; },
    dispose() { disposed = true; items.clear(); inventories.clear(); equipment.clear(); },
  };
};
