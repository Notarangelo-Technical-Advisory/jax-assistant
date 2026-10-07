# Coding

## Stack

- Angular 22 with TypeScript 6. Use standalone components only, never NgModules.
- Firebase 11 through the Firebase JS SDK and `rxfire`. Do not use AngularFire. See [decisions/0003](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0003-firebase-sdk-without-angularfire.md).
- Provide Firebase services through injection tokens defined in `src/app/firebase.ts`. Components and services inject the token. They do not call `getFirestore()` themselves.
- Cloud Functions are TypeScript, second generation, in `functions/src/`.

## Structure

- Put all Firebase reads and writes in services in `src/app/services/`, never in components. Services return Observables or Promises and handle errors. Components show the result and any error to the user.
- Put route guards in `src/app/guards/` and routes in `src/app/app.routes.ts`.
- Put data interfaces in `src/app/models/`.
- Put environment settings in `src/environments/`. Never put credentials there.

## TypeScript

- `strict` is on in every `tsconfig.json`.
- Do not use `any` in new code. The lint rule allows it today only because older Firebase code depends on it.
- Never leave a Promise unhandled. Either `await` it, or mark a deliberate fire-and-forget call with `void`. Inside a Cloud Function, an unawaited call can stop when the function returns.

## Angular

- Angular 22 makes `OnPush` the default. The upgrade set existing components to `Eager`, so that their screens update as before. Move a component to `OnPush` only after you have checked that it does not change state after an `await`.
- Keep `zone.js` until every component has been checked.
- Firestore returns `Timestamp` objects, not `Date` objects. Convert them before using the `date` pipe, or it throws `NG02100`.
- On a page refresh, `auth.currentUser` is `null` until Firebase restores the session. Wait for the auth state before deciding that a user is signed out.

## Style and formatting

- Use the design tokens in the app's tokens file. Never hardcode colours, spacing or fonts.
- Use SCSS for component styles. Do not use inline styles.
- Use semantic HTML and ARIA attributes. Every action must work with the keyboard.
- `.editorconfig` sets UTF-8, 2-space indentation, single quotes in TypeScript and a final newline.
- ESLint must pass (`npm run lint`). The shared config, based on Solomon's, will live in `config/eslint.config.mjs` in this repo.

## Scripts

- Use only the scripts in `package.json`. Do not run one-off commands that someone else cannot repeat.
- Migration scripts go in `scripts/`. They are TypeScript, can run twice safely, log their progress, and run only after a Firestore backup.
