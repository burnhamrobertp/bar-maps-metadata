// Shows field-level differences between local map data and current Webflow content.

import util from 'util';
import { WebflowClient } from 'webflow-api';
import Bottleneck from 'bottleneck';
import { program } from '@commander-js/extra-typings';
import { readMapList, fetchMapsMetadata } from './maps_metadata.js';
import { readMapCDNInfos } from './cdn_maps.js';
import {
    WebsiteMapInfo,
    sameImage,
    sameImages,
    buildWebflowInfo,
    getFieldCollection,
    getAllWebflowMaps,
    getAllWebflowMapTags,
    getAllWebflowMapTerrains,
} from './webflow_common.js';

if (!process.env.WEBFLOW_COLLECTION_ID || !process.env.WEBFLOW_API_TOKEN) {
    console.error('Missing WEBFLOW_COLLECTION_ID or WEBFLOW_API_TOKEN');
    process.exit(1);
}
const webflow = new WebflowClient({ accessToken: process.env.WEBFLOW_API_TOKEN });
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 600 });
const mapsCollectionId = process.env.WEBFLOW_COLLECTION_ID;

const ansi = {
    reset:  '\x1b[0m',
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
};

interface FieldDiff {
    field: string;
    local: unknown;
    webflow: unknown;
}

async function diffWebflowMapInfo(
    local: WebsiteMapInfo,
    wf: WebsiteMapInfo,
    tagIdToSlug: Map<string, string>,
    terrainIdToSlug: Map<string, string>,
): Promise<FieldDiff[]> {
    const diffs: FieldDiff[] = [];

    const check = (field: string, a: unknown, b: unknown) => {
        if (a !== b) diffs.push({ field, local: a, webflow: b });
    };

    const [
        sameMin, sameMiniThumb, sameBg, samePersp, sameMore, sameTex, sameHgt, sameMetal,
    ] = await Promise.all([
        sameImage(local.minimapUrl, wf.minimapUrl),
        sameImage(local.minimapThumbUrl, wf.minimapThumbUrl),
        sameImage(local.bgImageUrl, wf.bgImageUrl),
        sameImage(local.perspectiveShotUrl, wf.perspectiveShotUrl),
        sameImages(local.moreImagesUrl, wf.moreImagesUrl),
        sameImage(local.textureMapUrl, wf.textureMapUrl),
        sameImage(local.heightMapUrl, wf.heightMapUrl),
        sameImage(local.metalMapUrl, wf.metalMapUrl),
    ]);

    if (!sameMin)       diffs.push({ field: 'minimap',         local: local.minimapUrl,         webflow: wf.minimapUrl });
    if (!sameMiniThumb) diffs.push({ field: 'minimapThumb',    local: local.minimapThumbUrl,    webflow: wf.minimapThumbUrl });
    if (!sameBg)        diffs.push({ field: 'bgImage',         local: local.bgImageUrl,         webflow: wf.bgImageUrl });
    if (!samePersp)     diffs.push({ field: 'perspectiveShot', local: local.perspectiveShotUrl, webflow: wf.perspectiveShotUrl });
    if (!sameMore)      diffs.push({ field: 'moreImages',      local: local.moreImagesUrl,      webflow: wf.moreImagesUrl });
    if (!sameTex)       diffs.push({ field: 'textureMap',      local: local.textureMapUrl,      webflow: wf.textureMapUrl });
    if (!sameHgt)       diffs.push({ field: 'heightMap',       local: local.heightMapUrl,       webflow: wf.heightMapUrl });
    if (!sameMetal)     diffs.push({ field: 'metalMap',        local: local.metalMapUrl,        webflow: wf.metalMapUrl });

    check('name', local.name, wf.name);
    check('downloadUrl', local.downloadUrl, wf.downloadUrl);
    check('width', local.width, wf.width);
    check('height', local.height, wf.height);
    check('mapSize', local.mapSize, wf.mapSize);
    check('title', local.title, wf.title);
    check('description', local.description, wf.description);
    check('author', local.author, wf.author);
    check('mapHeightMin', local.mapHeightMin, wf.mapHeightMin);
    check('mapHeightMax', local.mapHeightMax, wf.mapHeightMax);
    check('windMin', local.windMin, wf.windMin);
    check('windMax', local.windMax, wf.windMax);
    check('tidalStrength', local.tidalStrength, wf.tidalStrength);
    check('teamCount', local.teamCount, wf.teamCount);
    check('maxPlayers', local.maxPlayers, wf.maxPlayers);

    const localTags = [...local.mapTags].sort();
    const wfTags = wf.mapTags.map(id => tagIdToSlug.get(id) ?? id).sort();
    if (JSON.stringify(localTags) !== JSON.stringify(wfTags)) {
        diffs.push({ field: 'mapTags', local: localTags, webflow: wfTags });
    }

    const localTerrains = [...local.mapTerrains].sort();
    const wfTerrains = wf.mapTerrains.map(id => terrainIdToSlug.get(id) ?? id).sort();
    if (JSON.stringify(localTerrains) !== JSON.stringify(wfTerrains)) {
        diffs.push({ field: 'mapTerrains', local: localTerrains, webflow: wfTerrains });
    }

    return diffs;
}

async function diffCommand() {
    const mapsCollection = await limiter.schedule(() => webflow.collections.get(mapsCollectionId));
    const webflowMaps = await getAllWebflowMaps(mapsCollection, webflow, limiter);
    const mapTagsCollection = await getFieldCollection('game-tags-ref-2', mapsCollection, webflow);
    const webflowMapTags = await getAllWebflowMapTags(mapTagsCollection, webflow, limiter);
    const mapTerrainsCollection = await getFieldCollection('terrain-types', mapsCollection, webflow);
    const webflowMapTerrains = await getAllWebflowMapTerrains(mapTerrainsCollection, webflow, limiter);
    const maps = await readMapList();
    const cdnInfo = await readMapCDNInfos();
    const mapsMetadata = await fetchMapsMetadata(maps);
    const [rowyMapsInfo] = await buildWebflowInfo(maps, cdnInfo, mapsMetadata);

    const tagIdToSlug = new Map(Array.from(webflowMapTags.values()).map(t => [t.item.id, t.slug]));
    const terrainIdToSlug = new Map(Array.from(webflowMapTerrains.values()).map(t => [t.item.id, t.slug]));

    let totalAdded = 0, totalRemoved = 0, totalChanged = 0;

    for (const map of rowyMapsInfo.values()) {
        if (!webflowMaps.has(map.rowyId)) {
            console.log(`${ansi.green}+ ${map.name} [new]${ansi.reset}`);
            totalAdded++;
        }
    }

    for (const wfMap of webflowMaps.values()) {
        if (!rowyMapsInfo.has(wfMap.rowyId)) {
            console.log(`${ansi.red}- ${wfMap.name} [removed]${ansi.reset}`);
            totalRemoved++;
        }
    }

    const diffResults = await Promise.all(
        Array.from(rowyMapsInfo.values())
            .filter(map => webflowMaps.has(map.rowyId))
            .map(async map => {
                const wfMap = webflowMaps.get(map.rowyId)!;
                const diffs = await diffWebflowMapInfo(map, wfMap, tagIdToSlug, terrainIdToSlug);
                return { map, diffs };
            })
    );

    for (const { map, diffs } of diffResults) {
        if (diffs.length === 0) continue;
        totalChanged++;
        console.log(`${ansi.yellow}~ ${map.name}:${ansi.reset}`);
        for (const { field, local, webflow } of diffs) {
            console.log(`  ${ansi.cyan}${field}:${ansi.reset}`);
            console.log(`    local:   ${util.inspect(local, { depth: null, colors: true })}`);
            console.log(`    webflow: ${util.inspect(webflow, { depth: null, colors: true })}`);
        }
    }

    console.log(`\nSummary: ${totalAdded} added, ${totalRemoved} removed, ${totalChanged} changed`);
}

program.name('diff_webflow')
    .description('Shows field-level differences between local data and current Webflow content.')
    .action(() => diffCommand());

program.parse();
