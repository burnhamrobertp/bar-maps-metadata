// Synces maps data to Webflow collection.

import util from 'util';
import { WebflowClient, Webflow } from 'webflow-api';
import Bottleneck from 'bottleneck';
import { program } from '@commander-js/extra-typings';
import { readMapList, fetchMapsMetadata } from './maps_metadata.js';
import { readMapCDNInfos } from './cdn_maps.js';
import mapSchema from '../../../gen/schemas/map_list.json';
import {
    IWebsiteItem,
    IWebflowItem,
    IWebflowItemType,
    ExistingCollectionItem,
    WebsiteMapTag,
    WebflowMapTag,
    isWebsiteMapTagEqual,
    WebsiteMapTerrain,
    WebflowMapTerrain,
    isWebsiteMapTerrainEqual,
    WebsiteMapInfo,
    WebflowMapInfo,
    isWebflowMapInfoEqual,
    fieldsToItem,
    buildWebflowInfo,
    getFieldCollection,
    resolveItemRefsInMapInfos,
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

async function syncCollectionToWebflowAdditions(
    webflowItemType: IWebflowItemType,
    equals: (a: IWebsiteItem, b: IWebflowItem) => boolean,
    typeName: string,
    src: Map<string, IWebsiteItem>,
    dest: Map<string, IWebflowItem>,
    collection: Webflow.Collection,
    dryRun: boolean,
) {
    for (const item of src.values()) {
        const webflowTag = dest.get(item.slug);
        if (!webflowTag) {
            const fields = webflowItemType.generateFields(item);
            console.log(`Adding ${typeName} ${item.name}`);
            if (!dryRun) {
                const item = await limiter.schedule(
                    () => webflow.collections.items.createItem(
                        collection.id, fieldsToItem(fields)));
                dest.set(item.fieldData.slug, new webflowItemType(item));
            } else {
                console.log(fields);
            }
        } else if (!equals(item, webflowTag)) {
            console.log(`Updating ${typeName} ${item.name}`);
            const fields = webflowItemType.generateFields(item);
            if (!dryRun) {
                const itemPatch = fieldsToItem(fields);
                itemPatch.id = webflowTag.item.id;
                const item = await limiter.schedule(
                    () => webflow.collections.items.updateItem(
                        collection.id, webflowTag.item.id, itemPatch));
                dest.set(item.fieldData.slug, new webflowItemType(item));
            } else {
                console.log(webflowTag);
                console.log(fields);
            }
        }
    }
}

async function syncCollectionToWebflowRemovals(
    collection: Webflow.Collection,
    typeName: string,
    src: Map<string, IWebsiteItem>,
    dest: Map<string, IWebflowItem>,
    dryRun: boolean,
) {
    for (const item of dest.values()) {
        if (!src.has(item.slug)) {
            console.log(`Removing ${typeName} ${item.name}`);
            if (!dryRun) {
                await limiter.schedule(() => webflow.collections.items.deleteItem(collection.id, item.item.id));
                dest.delete(item.slug);
            }
        }
    }
}

async function syncMapTagsToWebflowAdditions(
    src: Map<string, WebsiteMapTag>,
    dest: Map<string, WebflowMapTag>,
    mapTagsCollection: Webflow.Collection,
    dryRun: boolean
) {
    return syncCollectionToWebflowAdditions(WebflowMapTag, isWebsiteMapTagEqual, 'tag', src, dest, mapTagsCollection, dryRun);
}

async function syncMapTagsToWebflowRemovals(
    collection: Webflow.Collection,
    src: Map<string, WebsiteMapTag>,
    dest: Map<string, WebflowMapTag>,
    dryRun: boolean
) {
    return syncCollectionToWebflowRemovals(collection, 'tag', src, dest, dryRun);
}

async function syncMapTerrainsToWebflowAdditions(
    src: Map<string, WebsiteMapTerrain>,
    dest: Map<string, WebflowMapTerrain>,
    mapTerrainsCollection: Webflow.Collection,
    dryRun: boolean
) {
    return syncCollectionToWebflowAdditions(WebflowMapTerrain, isWebsiteMapTerrainEqual, 'terrain', src, dest, mapTerrainsCollection, dryRun);
}

async function syncMapTerrainsToWebflowRemovals(
    collection: Webflow.Collection,
    src: Map<string, WebsiteMapTerrain>,
    dest: Map<string, WebflowMapTerrain>,
    dryRun: boolean
) {
    return syncCollectionToWebflowRemovals(collection, 'terrain', src, dest, dryRun);
}

function getRowyMapTerrains(): Map<string, WebsiteMapTerrain> {
    const terrains = mapSchema['$defs'].terrainType.enum;
    return new Map(terrains.map(t => [t, { name: t, slug: t }]));
}

async function syncMapsToWebflow(
    src: Map<string, WebsiteMapInfo>,
    dest: Map<string, WebflowMapInfo>,
    mapsCollection: Webflow.Collection,
    dryRun: boolean
) {
    const updatesP: Promise<[boolean, WebsiteMapInfo, WebflowMapInfo]>[] = [];
    for (const map of src.values()) {
        const webflowMap = dest.get(map.rowyId);
        if (!webflowMap) {
            const fields = await WebflowMapInfo.generateFields(map);
            console.log(`Adding ${map.name}`);
            if (!dryRun) {
                const item = await limiter.schedule(
                    () => webflow.collections.items.createItem(
                        mapsCollection.id, fieldsToItem(fields)));
                dest.set(map.rowyId, new WebflowMapInfo(item));
            } else {
                console.log(fields);
            }
        } else {
            updatesP.push((async () => [await isWebflowMapInfoEqual(map, webflowMap), map, webflowMap])())
        }
    }
    for (const map of dest.values()) {
        if (!src.has(map.rowyId)) {
            console.log(`Removing ${map.name}`);
            if (!dryRun) {
                await limiter.schedule(() => webflow.collections.items.deleteItem(mapsCollection.id, map.item.id));
                dest.delete(map.rowyId);
            }
        }
    }
    const updates = await Promise.all(updatesP);
    for (const [_, map, webflowMap] of updates.filter(([same]) => !same)) {
        console.log(`Updating ${map.name}`);
        const fields = await WebflowMapInfo.generateFields(map, webflowMap);
        if (!dryRun) {
            const itemPatch = fieldsToItem(fields);
            itemPatch.id = webflowMap.item.id;
            const item = await limiter.schedule(
                () => webflow.collections.items.updateItem(
                    mapsCollection.id, webflowMap.item.id, itemPatch));
            dest.set(map.rowyId, new WebflowMapInfo(item));
        } else {
            console.log(webflowMap);
            console.log(fields);
        }
    }
}

async function publishUpdatedWebflowItems(collection: Webflow.Collection, items: Map<any, { item: ExistingCollectionItem }>, dryRun: boolean) {
    const itemIds = Array.from(items.values())
        .map(i => i.item)
        .filter(i => !i.lastPublished || Date.parse(i.lastPublished) < Date.parse(i.lastUpdated!))
        .map(i => i.id);
    console.log(`Publishing ${itemIds.length} items`);
    if (!dryRun) {
        const chunkSize = 100;
        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const itemIdsChunk = itemIds.slice(i, i + chunkSize);
            await limiter.schedule(() => webflow.collections.items.publishItem(collection.id, { itemIds: itemIdsChunk }));
        }
    }
}

program.name('sync_to_webflow');

async function syncCommand(dryRun: boolean) {
    const mapsCollection = await limiter.schedule(() => webflow.collections.get(mapsCollectionId));
    const webflowMaps = await getAllWebflowMaps(mapsCollection, webflow, limiter);
    const mapTagsCollection = await getFieldCollection('game-tags-ref-2', mapsCollection, webflow);
    const webflowMapTags = await getAllWebflowMapTags(mapTagsCollection, webflow, limiter);
    const mapTerrainsCollection = await getFieldCollection('terrain-types', mapsCollection, webflow);
    const webflowMapTerrains = await getAllWebflowMapTerrains(mapTerrainsCollection, webflow, limiter);
    const maps = await readMapList();
    const cdnInfo = await readMapCDNInfos();
    const mapsMetadata = await fetchMapsMetadata(maps);
    const [rowyMapsInfo, rowyMapTagsInfo] = await buildWebflowInfo(maps, cdnInfo, mapsMetadata);
    const rowyMapTerrainsInfo = getRowyMapTerrains();

    try {
        await syncMapTagsToWebflowAdditions(rowyMapTagsInfo, webflowMapTags, mapTagsCollection, dryRun);
        resolveItemRefsInMapInfos(rowyMapsInfo, 'mapTags', webflowMapTags, dryRun);
        await syncMapTerrainsToWebflowAdditions(rowyMapTerrainsInfo, webflowMapTerrains, mapTerrainsCollection, dryRun);
        resolveItemRefsInMapInfos(rowyMapsInfo, 'mapTerrains', webflowMapTerrains, dryRun);
        await syncMapsToWebflow(rowyMapsInfo, webflowMaps, mapsCollection, dryRun);
        await publishUpdatedWebflowItems(mapTerrainsCollection, webflowMapTerrains, dryRun);
        await publishUpdatedWebflowItems(mapTagsCollection, webflowMapTags, dryRun);
        await publishUpdatedWebflowItems(mapsCollection, webflowMaps, dryRun);
        await syncMapTagsToWebflowRemovals(mapTagsCollection, rowyMapTagsInfo, webflowMapTags, dryRun);
        await syncMapTerrainsToWebflowRemovals(mapTerrainsCollection, rowyMapTerrainsInfo, webflowMapTerrains, dryRun);
    } catch (e: any) {
        // To make sure we will get full info from inside of the response.
        if ('message' in e) {
            console.error(e.message);
        } else {
            console.error(e);
        }
        if ('response' in e) {
            console.error(e.response.data);
        }
        process.exit(1);
    }
}

program.command('sync')
    .description('Syncs data from Rowy to Webflow.')
    .option('-d, --dry-run', 'Only compute and print difference, don\'t sync.', false)
    .action(({ dryRun }) => syncCommand(dryRun));

program.command('dump-data')
    .description('Dumps Webflow collection data.')
    .action(async () => {
        const mapsCollection = await limiter.schedule(() => webflow.collections.get(mapsCollectionId));
        const webflowMaps = await getAllWebflowMaps(mapsCollection, webflow, limiter);
        console.log(util.inspect(webflowMaps, { showHidden: false, depth: null, colors: true }));

        const mapTagsCollection = await getFieldCollection('game-tags-ref-2', mapsCollection, webflow);
        const mapTags = await getAllWebflowMapTags(mapTagsCollection, webflow, limiter);
        console.log(util.inspect(mapTags, { showHidden: false, depth: null, colors: true }));

        const mapTerrainsCollection = await getFieldCollection('terrain-types', mapsCollection, webflow);
        const webflowTerrains = await getAllWebflowMapTerrains(mapTerrainsCollection, webflow, limiter);
        console.log(util.inspect(webflowTerrains, { showHidden: false, depth: null, colors: true }));
    });

program.parse();
