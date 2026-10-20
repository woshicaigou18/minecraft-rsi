import settings from '../settings.js';

export async function addBrowserViewer(bot, count_id) {
    if (settings.render_bot_view) {
        const { default: prismarineViewer } = await import('prismarine-viewer');
        prismarineViewer.mineflayer(bot, { port: 3000+count_id, firstPerson: true });
    }
}
