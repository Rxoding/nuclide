/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * Search all subdirectories of the header file for a source file that includes it.
 * We handle the two most common types of include statements:
 *
 * 1) Includes relative to the project root (if supplied); e.g. #include <a/b.h>
 * 2) Includes relative to the source file; e.g. #include "../../a.h"
 *
 * Note that we use an Observable here to enable cancellation.
 * The resulting Observable fires and completes as soon as a matching file is found;
 * 'null' will always be emitted if no results are found.
 */
import nuclideUri from 'nuclide-commons/nuclideUri';
import {observeProcess} from 'nuclide-commons/process';
import {Observable} from 'rxjs';
import {isSourceFile} from '../utils';
import escapeStringRegExp from 'escape-string-regexp';

const INCLUDE_SEARCH_TIMEOUT = 15000;

export function findIncludingSourceFile(
  headerFile: string,
  projectRoot: string,
): Observable<?string> {
  return _findIncludingSourceFile(headerFile, projectRoot)
    .timeout(INCLUDE_SEARCH_TIMEOUT)
    .catch(() => Observable.of(null));
}

function _findIncludingSourceFile(
  headerFile: string,
  projectRoot: string,
): Observable<?string> {
  const basename = escapeStringRegExp(nuclideUri.basename(headerFile));
  const relativePath = escapeStringRegExp(
    nuclideUri.relative(projectRoot, headerFile),
  );
  const pattern = `^\\s*#include\\s+["<](${relativePath}|(../)*${basename})[">]\\s*$`;
  const regex = new RegExp(pattern);
  // We need both the file and the match to verify relative includes.
  // Relative includes may not always be correct, so we may have to go through all the results.
  return observeProcess(
    'grep',
    [
      '-RE', // recursive, extended
      '--null', // separate file/match with \0
      pattern,
      nuclideUri.dirname(headerFile),
    ],
    {/* TODO(T17353599) */ isExitError: () => false},
  )
    .catch(error => Observable.of({kind: 'error', error})) // TODO(T17463635)
    .flatMap(message => {
      switch (message.kind) {
        case 'stdout':
          const file = processGrepResult(message.data, headerFile, regex);
          return file == null ? Observable.empty() : Observable.of(file);
        case 'error':
          throw new Error(String(message.error));
        case 'exit':
          return Observable.of(null);
        default:
          return Observable.empty();
      }
    })
    .take(1);
}

function processGrepResult(
  result: string,
  headerFile: string,
  includeRegex: RegExp,
): ?string {
  const splitIndex = result.indexOf('\0');
  if (splitIndex === -1) {
    return null;
  }
  const filename = result.substr(0, splitIndex);
  if (!isSourceFile(filename)) {
    return null;
  }
  const match = includeRegex.exec(result.substr(splitIndex + 1));
  if (match == null) {
    return null;
  }
  // Source-relative includes have to be verified.
  // Relative paths will match the (../)* rule (at index 2).
  if (match[2] != null) {
    const includePath = nuclideUri.normalize(
      nuclideUri.join(nuclideUri.dirname(filename), match[1]),
    );
    if (includePath !== headerFile) {
      return null;
    }
  }
  return filename;
}
