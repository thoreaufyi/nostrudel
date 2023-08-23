import { nip19 } from "nostr-tools";

import { NostrRequest } from "../classes/nostr-request";
import { PersistentSubject } from "../classes/subject";
import { NostrEvent, isPTag } from "../types/nostr-event";
import { getEventRelays } from "./event-relays";
import relayScoreboardService from "./relay-scoreboard";
import { getEventCoordinate } from "../helpers/nostr/events";
import { draftAddPerson, draftRemovePerson, getListName } from "../helpers/nostr/lists";
import replaceableEventLoaderService from "./replaceable-event-requester";

/** @deprecated */
export class List {
  event: NostrEvent;
  cord: string;
  people = new PersistentSubject<{ pubkey: string; relay?: string }[]>([]);

  get author() {
    return this.event.pubkey;
  }
  get name() {
    return getListName(this.event)!;
  }

  getAddress() {
    // pick fastest for event
    const relays = relayScoreboardService.getRankedRelays(getEventRelays(this.event.id).value).slice(0, 1);

    return nip19.naddrEncode({
      pubkey: this.event.pubkey,
      identifier: this.name,
      relays,
      kind: this.event.kind,
    });
  }

  constructor(event: NostrEvent) {
    this.event = event;
    this.cord = getEventCoordinate(event);
    this.updatePeople();
  }

  private updatePeople() {
    const people = this.event.tags.filter(isPTag).map((p) => ({ pubkey: p[1], relay: p[2] }));
    this.people.next(people);
  }
  handleEvent(event: NostrEvent) {
    if (event.created_at > this.event.created_at) {
      this.event = event;
      this.updatePeople();
    }
  }

  draftAddPerson(pubkey: string, relay?: string) {
    return draftAddPerson(this.event, pubkey, relay);
  }

  draftRemovePerson(pubkey: string) {
    return draftRemovePerson(this.event, pubkey);
  }
}

class ListsService {
  private lists = new Map<string, List>();
  private pubkeyLists = new Map<string, PersistentSubject<Record<string, List>>>();

  private fetchingPubkeys = new Set();
  fetchListsForPubkey(pubkey: string, relays: string[]) {
    if (this.fetchingPubkeys.has(pubkey)) return this.pubkeyLists.get(pubkey)!;
    this.fetchingPubkeys.add(pubkey);

    if (!this.pubkeyLists.has(pubkey)) {
      this.pubkeyLists.set(pubkey, new PersistentSubject<Record<string, List>>({}));
    }
    let subject = this.pubkeyLists.get(pubkey)!;

    const request = new NostrRequest(relays);
    request.onEvent.subscribe((event) => {
      replaceableEventLoaderService.handleEvent(event);

      const listName = getListName(event);

      if (listName && event.kind === 30000) {
        if (subject.value[listName]) {
          subject.value[listName].handleEvent(event);
        } else {
          const list = new List(event);
          this.lists.set(event.id, list);
          subject.next({ ...subject.value, [listName]: list });
        }
      }
    });
    request.start({ kinds: [30000], authors: [pubkey] });

    return subject;
  }

  requestUserLists(pubkey: string, relays: string[], alwaysFetch = false) {
    if (!this.pubkeyLists.has(pubkey) || alwaysFetch) {
      return this.fetchListsForPubkey(pubkey, relays);
    }
    return this.pubkeyLists.get(pubkey)!;
  }

  getListsForPubkey(pubkey: string) {
    return this.pubkeyLists.get(pubkey);
  }
}

const listsService = new ListsService();

if (import.meta.env.DEV) {
  //@ts-ignore
  window.listsService = listsService;
}

export default listsService;
