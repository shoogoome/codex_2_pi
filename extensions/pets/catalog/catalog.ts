export interface BuiltinPetEntry {
  id: string;
  displayName: string;
  description: string;
  /** Path to the pet directory's manifest, relative to this catalog folder. */
  manifestRelPath: string;
}

const BUILTIN_PETS: BuiltinPetEntry[] = [
  {
    id: "default",
    displayName: "Default",
    description: "A small CC0 pet bundled with the pets extension.",
    manifestRelPath: "default/pet.json",
  },
];

export const BUILTIN_PET_IDS = BUILTIN_PETS.map((pet) => pet.id);

export function builtinPet(id: string): BuiltinPetEntry | undefined {
  return BUILTIN_PETS.find((pet) => pet.id === id);
}

export function builtinPets(): readonly BuiltinPetEntry[] {
  return BUILTIN_PETS;
}
