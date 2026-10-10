import assert from 'node:assert/strict';
import { fields, typeNames } from './describe.mjs';

// The bundle ships no reflection metadata, so field layouts are recovered from the
// generated encode/decode bodies. These expectations are the ones read by eye from the
// source; if the extractor drifts, phase-2 message work silently breaks.
function layout(name) {
  return fields(name).map((field) => `${field.number}:${field.name}:${field.kind}:${field.type}`);
}

assert.deepEqual(layout('LoginResponse'), [
  '1:result:scalar:int32',
  '2:playerInfo:message:PlayerInfo',
  '3:errorMessage:scalar:string',
  '4:initSeqNo:scalar:int32',
]);

assert.deepEqual(layout('LoginRequest'), [
  '1:testAccount:scalar:string',
  '4:language:scalar:string',
  '5:superToken:scalar:string',
  '6:eworldParams:message:EworldLoginParams',
  '7:eworldClientInfo:message:EworldClientInfo',
  '8:worldId:scalar:int64',
  '9:systemLanguage:scalar:string',
]);

assert.deepEqual(layout('GameWorldInfo'), [
  '1:worldId:scalar:int64',
  '2:tag:scalar:int32',
  '3:roleInfo:message:AccountRoleInfo',
]);

assert.deepEqual(layout('GameWorldListResponse'), [
  '1:recentWorlds:repeated:GameWorldInfo',
  '2:latestGroupId:scalar:int32',
]);

assert.deepEqual(layout('GameWorldGroupListResponse'), ['1:worlds:repeated:GameWorldInfo']);
assert.deepEqual(layout('GameWorldListRequest'), [], 'world list request is empty');
assert.deepEqual(layout('ExitWorldMapRequest'), [], 'exit world map request is empty');

assert.deepEqual(layout('GameWorldGroupListRequest'), ['1:groupId:scalar:int32']);
assert.equal(fields('GameWorldGroupListRequest')[0].required, true, 'groupId is proto2 required');

assert.deepEqual(layout('PingRequest'), ['1:clientTimestamp:scalar:int64']);

// PlayerInfo is wide; spot-check the identity fields the world listing depends on.
{
  const byName = new Map(fields('PlayerInfo').map((field) => [field.name, field]));
  assert.equal(byName.get('playerId').number, 1);
  assert.equal(byName.get('playerId').type, 'int64');
  assert.equal(byName.get('nickname').number, 2);
  assert.equal(byName.get('level').number, 7);
  assert.equal(byName.get('power').number, 10);
  assert.equal(byName.get('newRole').number, 11);
  assert.equal(byName.get('newRole').type, 'bool');
  assert.equal(byName.get('worldId').number, 12);
}

// AccountRoleInfo carries the same identity under different numbers; the world listing
// reads worldId (10) and bornWorldId (5) from it.
{
  const byName = new Map(fields('AccountRoleInfo').map((field) => [field.name, field]));
  assert.equal(byName.get('bornWorldId').number, 5);
  assert.equal(byName.get('worldId').number, 10);
  assert.equal(byName.get('lastLoginTime').number, 11);
}

// A single-field type exercises the `i>>>3==N?` decode form the extractor normalises.
assert.deepEqual(layout('Position'), ['1:x:scalar:int32', '2:y:scalar:int32']);

const total = typeNames().length;
assert.ok(total > 1400, `expected the full protocol table, got ${total} types`);

console.log(`selftest ok: describe recovered field layouts for ${total} protocol types`);
