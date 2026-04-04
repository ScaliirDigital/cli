# @scale.digital/astro-bun

An Astro 6 adapter for Bun with:

- static file serving  
- ETag / 304 caching support  
- ISR (Incremental Static Regeneration)

Forked from [@wyattjoh/astro-bun-adapter](
https://github.com/wyattjoh/astro-bun-adapter), updated for Astro 6
using `entrypointResolution: "auto"`.

Removes all external dependencies and adopts a functional
implementation.

> **Work in progress**
>
> - Validated locally with Astro 6.1.3 and `@qwik.dev/astro` 1.0.1
> - Test coverage focuses on ISR and cache behavior
