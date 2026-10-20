# Third-party artwork

Artwork from other projects that is copied into Fontface's source, rather than installed as a
package. Packages keep their own licences in `node_modules` and the Rust registry.

## Service marks in the sidebar

`src/components/BrandIcon.tsx` draws the marks of the two sources that are online services, in
one color, to label those integrations in the sidebar. The marks belong to their owners
(Google LLC and Adobe Inc.); Fontface uses them only to name the service a source comes from.

### Google Fonts: Simple Icons

- Source: `icons/googlefonts.svg` in Simple Icons, https://github.com/simple-icons/simple-icons
  (https://simpleicons.org). Path data copied as is, drawn filled in the text color.
- Licence: CC0 1.0 Universal (public domain dedication):
  https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md

### Adobe (for Adobe Fonts): Tabler Icons

- Source: `icons/outline/brand-adobe.svg` in Tabler Icons, https://github.com/tabler/tabler-icons
  (https://tabler.io/icons). Path data copied as is, drawn as a 2-unit round outline in the text
  color. Simple Icons removed Adobe's marks in its version 14, so this one comes from Tabler.
- Licence: MIT, reproduced here as its terms require.

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
