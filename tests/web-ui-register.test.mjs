import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebUiRegistrar } from '../lib/index.js';

test('WEBUI-REGISTER-01: apply 与 ready 多次调用只注册一次', () => {
  let registrations = 0;
  const ctx = { server: { get() {}, post() {} } };
  const registrar = createWebUiRegistrar(
    ctx,
    () => {
      registrations += 1;
    },
    (error) => {
      throw error;
    },
  );
  registrar();
  registrar();
  registrar();
  assert.equal(registrations, 1, '路由与 TokenAuthority 不得双份');
});

test('WEBUI-REGISTER-02: 路由器未就绪时不标记，就绪后补注册', () => {
  let registrations = 0;
  const ctx = {};
  const registrar = createWebUiRegistrar(
    ctx,
    () => {
      registrations += 1;
    },
    () => undefined,
  );
  registrar();
  assert.equal(registrations, 0, '没有可挂路由时 registerWebUi 只会空转');

  ctx.server = { get() {} };
  registrar();
  registrar();
  assert.equal(registrations, 1);
});

test('WEBUI-REGISTER-03: 注册抛错不标记，下一次重试', () => {
  let registrations = 0;
  const errors = [];
  const ctx = { server: { get() {} } };
  const registrar = createWebUiRegistrar(
    ctx,
    () => {
      registrations += 1;
      if (registrations === 1) throw new Error('boom');
    },
    (error) => errors.push(error),
  );

  registrar();
  assert.equal(registrations, 1);
  assert.equal(errors.length, 1);

  registrar();
  assert.equal(registrations, 2);

  registrar();
  assert.equal(registrations, 2, '成功一次后不再重复注册');
});
