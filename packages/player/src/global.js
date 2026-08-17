import { mount, mountAll } from './player.js';

// Entry for dist/player.js - exposes window.CineHost for the iframe embed page
// and for anyone dropping a plain <script> tag on a page.
export { mount, mountAll };
export default { mount, mountAll };
