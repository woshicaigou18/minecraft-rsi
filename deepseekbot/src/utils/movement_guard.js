const finitePoint = point => point && ['x', 'y', 'z'].every(key => Number.isFinite(point[key]));

export function installMovementGuards(bot) {
    const write = bot._client.write.bind(bot._client);
    let warned = false;
    const warn = detail => {
        if (warned) return;
        warned = true;
        console.warn('[movement] Rejected invalid movement:', detail);
    };
    let lastFiniteState = null;
    const capture = () => {
        const entity = bot.entity;
        if (!finitePoint(entity?.position)) return;
        lastFiniteState = { x: entity.position.x, y: entity.position.y, z: entity.position.z,
            yaw: Number.isFinite(entity.yaw) ? entity.yaw : 0,
            pitch: Number.isFinite(entity.pitch) ? entity.pitch : 0 };
    };
    bot.on('spawn', capture);
    bot.on('forcedMove', capture);
    bot.on('physicsTick', () => {
        const entity = bot.entity;
        if (!entity || !lastFiniteState) return;
        if (finitePoint(entity.position) && finitePoint(entity.velocity) &&
            Number.isFinite(entity.yaw) && Number.isFinite(entity.pitch)) {
            capture();
            return;
        }
        warn(JSON.stringify({ recovery: true, position: entity.position,
            velocity: entity.velocity, yaw: entity.yaw, pitch: entity.pitch }));
        Object.assign(entity.position, { x: lastFiniteState.x, y: lastFiniteState.y, z: lastFiniteState.z });
        Object.assign(entity.velocity, { x: 0, y: 0, z: 0 });
        entity.yaw = lastFiniteState.yaw;
        entity.pitch = lastFiniteState.pitch;
        bot.clearControlStates();
        bot.pathfinder?.stop();
    });
    bot._client.write = (name, data) => {
        if (['position', 'position_look', 'look'].includes(name) &&
            ['x', 'y', 'z', 'yaw', 'pitch'].some(key => key in data && !Number.isFinite(data[key]))) {
            warn(JSON.stringify({ packet: name, data, position: bot.entity?.position,
                velocity: bot.entity?.velocity, yaw: bot.entity?.yaw, pitch: bot.entity?.pitch,
                attributes: bot.entity?.attributes }));
            return;
        }
        return write(name, data);
    };
    bot.once('login', () => {
        const look = bot.look.bind(bot);
        const lookAt = bot.lookAt.bind(bot);
        bot.look = (yaw, pitch, force) => {
            if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
                warn(`look(${yaw}, ${pitch})`);
                return Promise.resolve();
            }
            return look(yaw, pitch, force);
        };
        bot.lookAt = (point, force) => {
            if (!finitePoint(point) || !finitePoint(bot.entity?.position)) {
                warn(`lookAt(${JSON.stringify(point)})`);
                return Promise.resolve();
            }
            if (!Number.isFinite(bot.entity.eyeHeight)) bot.entity.eyeHeight = 1.62;
            return lookAt(point, force);
        };
    });
}
