// Pulls PocketJS's global JSX augmentation (opaque Node stand-in under
// lib ESNext, empty IntrinsicElements) into the typecheck program. The
// file lives in vendor/ which tsconfig excludes from its include globs;
// a triple-slash reference includes it regardless.
/// <reference path="../../vendor/pocketjs/framework/src/jsx.d.ts" />

export {};
