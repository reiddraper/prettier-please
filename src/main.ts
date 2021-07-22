import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'

import {IssueCommentEvent} from '@octokit/webhooks-types'

import * as prettier from 'prettier'

import {promises as fs} from 'fs'

type OctokitClient = ReturnType<typeof github.getOctokit>

const EYES_STRING = 'eyes'

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput('github-token', {required: true})
    const gitUserName = core.getInput('git-user.name', {required: true})
    const gitUserEmail = core.getInput('git-user.email', {required: true})

    if (github.context.eventName === 'issue_comment') {
      const payload = github.context.payload as IssueCommentEvent
      await processIssueComment(payload, githubToken, gitUserName, gitUserEmail)
    } else {
      core.error(
        `Event type was of unsupported type: ${github.context.eventName}`
      )
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

enum PrettierPleaseCommand {
  Prettier = 'Prettier',
  Nothing = 'Nothing'
}

async function processIssueComment(
  payload: IssueCommentEvent,
  githubToken: string,
  gitUserName: string,
  gitUserEmail: string
): Promise<void> {
  const command = testComment(payload.comment.body)
  core.debug('Processing comment:')
  core.debug(`${payload.comment.body}`)

  // Make sure a command was found
  if (command === PrettierPleaseCommand.Nothing) {
    core.debug(`Comment did not contain a command, exiting`)
    return
  }

  // Make sure the comment was not deleted
  if (payload.action === 'deleted') {
    return
  }

  const githubClient: OctokitClient = github.getOctokit(githubToken)

  // make sure the issue is a PR, we can't just use the issue from the payload,
  // since this does not distinguish between issues and PRs
  const issue = await githubClient.rest.issues.get({
    issue_number: github.context.issue.number,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo
  })

  // make sure the Issue is also a Pull Request, and that it's 'open'
  if (issue.data.pull_request?.url && issue.data.state === 'open') {
    await acknowledgeAndRunPrettier(
      githubClient,
      payload,
      issue.data.pull_request.url,
      gitUserName,
      gitUserEmail
    )
  } else {
    // Not a pull request
    core.debug(`Ran, but this was an Issue, and not a Pull Request`)
  }
}

async function acknowledgeAndRunPrettier(
  githubClient: OctokitClient,
  payload: IssueCommentEvent,
  pr_url: string,
  gitUserName: string,
  gitUserEmail: string
): Promise<void> {
  // add a reaction of 👀 to the comment
  await acknowledgeWithEyes(githubClient, payload)

  await runPrettierAndCommit(githubClient, pr_url, gitUserName, gitUserEmail)
}

async function runPrettierAndCommit(
  githubClient: OctokitClient,
  pr_url: string,
  gitUserName: string,
  gitUserEmail: string
): Promise<void> {
  const pr = await githubClient.request(pr_url)

  const filesToFormat = await findFilesToFormat(githubClient, pr.data.number)

  await exec.exec('git', ['fetch', 'origin', pr.data.head.ref])
  await exec.exec('git', ['checkout', pr.data.head.ref])

  for (const filename of filesToFormat) {
    const fileContents = (await fs.readFile(filename)).toString()
    const formatted = prettier.format(fileContents, {
      parser: 'markdown'
    })
    await fs.writeFile(filename, formatted)
  }

  await exec.exec('git', ['config', 'user.name', gitUserName])
  await exec.exec('git', ['config', 'user.email', gitUserEmail])
  await exec.exec('git', ['add'].concat(filesToFormat))

  // see if we made any changes
  const madeChanges = await exec.exec('git', ['diff', '--cached', '--quiet'], {
    ignoreReturnCode: true
  })

  if (madeChanges === 1) {
    await exec.exec('git', [
      'commit',
      '-m',
      'Format markdown files with Prettier'
    ])
    await exec.exec('git', ['push'])
  } else {
    await githubClient.rest.issues.createComment({
      issue_number: github.context.issue.number,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      body: `Prettier ran, but didn't make any changes to the files you added/modified.`
    })
  }
}

async function findFilesToFormat(
  githubClient: OctokitClient,
  pull_number: number
): Promise<string[]> {
  const filesToFormat = []
  const pr_files = await githubClient.paginate(
    githubClient.rest.pulls.listFiles,
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number,
      per_page: 100
    }
  )

  for (const file of pr_files) {
    if (
      (file.status === 'added' || file.status === 'modified') &&
      file.filename.endsWith('.md')
    ) {
      filesToFormat.push(file.filename)
    }
  }
  return filesToFormat
}

async function acknowledgeWithEyes(
  githubClient: OctokitClient,
  payload: IssueCommentEvent
): Promise<void> {
  await githubClient.rest.reactions.createForIssueComment({
    comment_id: payload.comment.id,
    content: EYES_STRING,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo
  })
}

function testComment(comment: string): PrettierPleaseCommand {
  if (comment.trim().toLowerCase().startsWith('prettier, please!')) {
    return PrettierPleaseCommand.Prettier
  } else {
    return PrettierPleaseCommand.Nothing
  }
}

run()
