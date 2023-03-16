//
// Copyright © 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import attachment from '@hcengineering/attachment'
import contact from '@hcengineering/contact'
import core, { BackupClient, Client as CoreClient, DOMAIN_TX, TxOperations, WorkspaceId } from '@hcengineering/core'
import { MinioService } from '@hcengineering/minio'
import { getWorkspaceDB } from '@hcengineering/mongo'
import recruit from '@hcengineering/recruit'
import { connect } from '@hcengineering/server-tool'
import tracker from '@hcengineering/tracker'
import { MongoClient } from 'mongodb'

export async function cleanWorkspace (
  mongoUrl: string,
  workspaceId: WorkspaceId,
  minio: MinioService,
  elasticUrl: string,
  transactorUrl: string,
  opt: { recruit: boolean, tracker: boolean, removeTx: boolean }
): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup',
    model: 'upgrade'
  })) as unknown as CoreClient & BackupClient
  try {
    const ops = new TxOperations(connection, core.account.System)

    const hierarchy = ops.getHierarchy()

    const attachments = await ops.findAll(attachment.class.Attachment, {})

    const contacts = await ops.findAll(contact.class.Contact, {})

    const files = new Set(
      attachments.map((it) => it.file).concat(contacts.map((it) => it.avatar).filter((it) => it) as string[])
    )

    const minioList = await minio.list(workspaceId)
    const toClean: string[] = []
    for (const mv of minioList) {
      if (!files.has(mv.name)) {
        toClean.push(mv.name)
      }
    }
    await minio.remove(workspaceId, toClean)
    // connection.loadChunk(DOMAIN_BLOB, idx = )

    if (opt.recruit) {
      const contacts = await ops.findAll(recruit.mixin.Candidate, {})
      console.log('removing Talents', contacts.length)
      const filter = contacts.filter((it) => !hierarchy.isDerived(it._class, contact.class.Employee))

      while (filter.length > 0) {
        const part = filter.splice(0, 100)
        const op = ops.apply('')
        for (const c of part) {
          await op.remove(c)
        }
        const t = Date.now()
        console.log('remove:', part.map((it) => it.name).join(', '))
        await op.commit()
        const t2 = Date.now()
        console.log('remove time:', t2 - t, filter.length)
      }

      // const vacancies = await ops.findAll(recruit.class.Vacancy, {})
      // console.log('removing vacancies', vacancies.length)
      // for (const c of vacancies) {
      //   console.log('Remove', c.name)
      //   await ops.remove(c)
      // }
    }

    if (opt.tracker) {
      const issues = await ops.findAll(tracker.class.Issue, {})
      console.log('removing Issues', issues.length)

      while (issues.length > 0) {
        const part = issues.splice(0, 5)
        const op = ops.apply('')
        for (const c of part) {
          await op.remove(c)
        }
        const t = Date.now()
        await op.commit()
        const t2 = Date.now()
        console.log('remove time:', t2 - t, issues.length)
      }
    }

    const client = new MongoClient(mongoUrl)
    try {
      await client.connect()
      const db = getWorkspaceDB(client, workspaceId)

      if (opt.removeTx) {
        const txes = await db.collection(DOMAIN_TX).find({}).toArray()

        for (const tx of txes) {
          if (tx._class === core.class.TxRemoveDoc) {
            // We need to remove all update and create operations for document
            await db.collection(DOMAIN_TX).deleteMany({ objectId: tx.objectId })
          }
        }
      }
    } finally {
      await client.close()
    }
  } catch (err: any) {
    console.trace(err)
  } finally {
    await connection.close()
  }
}